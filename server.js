/**
 * 亚马逊商品信息采集工具 - Node.js 版
 * 支持：主图/视频下载、标题、SKU、价格、关于此商品、品牌名称
 * 繁体自动转简体（品牌名除外），文字可复制，图片视频可下载
 */
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const OpenCC = require('opencc-js');
const archiver = require('archiver');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 8000;
const TMP_DIR = process.env.TMPDIR || '/tmp';

// 繁体 -> 简体
const converter = OpenCC.Converter({ from: 'tw', to: 'cn' });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
};

function t2s(text) {
  if (!text) return text;
  try { return converter(text); } catch (e) { return text; }
}

function cleanText(text) {
  if (!text) return text;
  return text
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 抓取亚马逊商品页面
 */
async function fetchAmazon(productUrl) {
  // 规范化 URL，强制 zh_TW + CNY，配送至中国以显示 AmazonGlobal 运费
  const parsed = new URL(productUrl);
  parsed.searchParams.set('language', 'zh_TW');
  parsed.searchParams.set('currency', 'CNY');
  parsed.searchParams.set('shipToCountry', 'CN');
  const cleanUrl = parsed.toString();

  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const instance = axios.create({
        headers: HEADERS,
        maxRedirects: 5,
        timeout: 30000,
        decompress: true,
      });
      // 先访问主页预热，并尝试设置配送至中国，收集 Cookie
      let cookieHeader = '';
      try {
        const warmup = await instance.get('https://www.amazon.com?shipToCountry=CN&currency=CNY', { timeout: 15000 });
        const setCookies = warmup.headers['set-cookie'];
        if (Array.isArray(setCookies) && setCookies.length) {
          cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');
        }
        await new Promise(r => setTimeout(r, 1000 + attempt * 500));
      } catch (e) { /* ignore warmup failure */ }

      const prodHeaders = { ...HEADERS };
      if (cookieHeader) prodHeaders['Cookie'] = cookieHeader;
      const r = await instance.get(cleanUrl, { headers: prodHeaders });
      if (r.status === 200 && !r.data.includes('validateCaptcha')) {
        return r.data;
      }
      lastErr = `status=${r.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise(r => setTimeout(r, 1500 + attempt * 1000));
  }
  throw new Error(`亚马逊返回了验证码页面或请求失败（${lastErr}），请稍后重试`);
}

/**
 * 解析所有主图大图（高清原图）
 */
function parseImages($) {
  const seen = [];
  const seenIds = new Set();

  // 从 landingImage 的 data-a-dynamic-image 提取最大尺寸图
  const li = $('#landingImage');
  if (li.length) {
    const dyn = li.attr('data-a-dynamic-image');
    if (dyn) {
      try {
        const map = JSON.parse(dyn);
        const urls = Object.keys(map);
        // 找最大尺寸的图
        let bestUrl = '', bestSize = 0;
        for (const u of urls) {
          const dims = map[u];
          const size = (dims[0] || 0) * (dims[1] || 0);
          if (size > bestSize) { bestSize = size; bestUrl = u; }
        }
        if (bestUrl) {
          const m = bestUrl.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
          const bid = m ? m[1] : bestUrl;
          if (!seenIds.has(bid)) {
            seenIds.add(bid);
            seen.push(bestUrl);
          }
        }
      } catch (e) { /* ignore */ }
    }
    // data-old-hires 作为兜底
    if (seen.length === 0) {
      const oh = li.attr('data-old-hires');
      if (oh) {
        const m = oh.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
        const bid = m ? m[1] : oh;
        if (!seenIds.has(bid)) {
          seenIds.add(bid);
          seen.push(oh);
        }
      }
    }
  }

  // 从 altImages 缩略图提取，转成最大尺寸 SL2000
  $('#altImages img').each((_, el) => {
    const src = $(el).attr('src') || '';
    const m = src.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
    if (m) {
      const bid = m[1];
      if (!seenIds.has(bid)) {
        seenIds.add(bid);
        seen.push(`https://m.media-amazon.com/images/I/${bid}._SL2000_.jpg`);
      }
    }
  });

  return seen;
}

/**
 * 解析视频 m3u8
 */
function parseVideo(html) {
  const m = html.match(/https:\/\/m\.media-amazon\.com\/images\/S\/[^&"']+\.m3u8/);
  if (!m) return null;
  const master = m[0];
  const stream720 = master.replace('.hls.m3u8', '.hls720.m3u8');
  return { master, stream720 };
}

/**
 * 从详情表中按关键字查找值
 */
function parseDetailRow($, keywords) {
  // detailBullets li 结构
  for (const li of $('#detailBullets_feature_div li').toArray()) {
    const text = cleanText($(li).text());
    for (const kw of keywords) {
      if (text.includes(kw)) {
        const parts = text.split(/[:：]/);
        if (parts.length >= 2) return cleanText(parts.slice(1).join(':'));
      }
    }
  }
  // 所有 tr 结构（不限于特定表格）
  for (const tr of $('tr').toArray()) {
    const text = cleanText($(tr).text());
    for (const kw of keywords) {
      if (text.includes(kw)) {
        // 优先用 th/td 分割
        const th = $(tr).find('th').first().text().trim();
        const td = $(tr).find('td').first().text().trim();
        if (th && td) return cleanText(td);
        // 否则用冒号分割
        const parts = text.split(/[:：]/);
        if (parts.length >= 2) return cleanText(parts.slice(1).join(':'));
      }
    }
  }
  return null;
}

function parseBrand($) {
  let brand = parseDetailRow($, ['品牌名稱', '品牌名称']);
  if (brand) return brand;
  // byline / 品牌旗舰店链接
  const a = $('a#bylineInfo, a[href*="/stores/"]').first();
  if (a.length) {
    const txt = a.text().trim();
    const m = txt.match(/造訪\s*(.+?)\s*品牌/);
    if (m) return cleanText(m[1]);
    if (txt && txt.length < 60) return cleanText(txt);
  }
  return null;
}

function parseSku($) {
  // 优先返回当前选中的变体名称（如"1瓶（4盎司）"）
  const selected = parseSelectedVariant($);
  if (selected) return selected;
  // 否则返回项目型号
  return parseDetailRow($, ['項目型號', '项目型号', 'Item model number', 'SKU', '庫存單位']);
}

/**
 * 解析当前选中的变体名称
 */
function parseSelectedVariant($) {
  // 遍历所有 a-button-selected 内的图片，找第一个有 alt 的
  const selImgs = $('.a-button-selected img').toArray();
  for (const el of selImgs) {
    const alt = cleanText($(el).attr('alt') || '');
    if (alt) return translateVariant(alt);
  }
  // aria-pressed=true
  const pressed = $('[aria-pressed="true"] img').toArray();
  for (const el of pressed) {
    const alt = cleanText($(el).attr('alt') || '');
    if (alt) return translateVariant(alt);
  }
  return null;
}

/**
 * 将变体名称翻译为中文
 */
function translateVariant(name) {
  if (!name) return name;
  let s = name;
  // 常见包装词汇翻译
  const rules = [
    [/\bCombo Pack\b/gi, '组合装'],
    [/\bVariety Pack\b/gi, '混合装'],
    [/\bPack of (\d+)\b/gi, '$1瓶装'],
    [/\b(\d+) Pack\b/gi, '$1瓶装'],
    [/\bPack\b/gi, '瓶装'],
    [/\bSingle\b/gi, '1瓶'],
    [/\bRefill\b/gi, '补充装'],
    [/\bCount\b/gi, '件'],
    [/\bCt\b/gi, '件'],
    [/\bOunce\b/gi, '盎司'],
    [/\bOunces\b/gi, '盎司'],
    [/(\d+)\s*oz\b/gi, '$1盎司'],
    [/\boz\b/gi, '盎司'],
    [/(\d+)\s*fl\s*oz\b/gi, '$1液量盎司'],
    [/\bml\b/gi, '毫升'],
    [/\bmL\b/gi, '毫升'],
    [/\bBottle\b/gi, '瓶'],
    [/\bBottles\b/gi, '瓶'],
    [/\bJar\b/gi, '罐'],
    [/\bJars\b/gi, '罐'],
    [/\bBag\b/gi, '袋'],
    [/\bBags\b/gi, '袋'],
    [/\bBox\b/gi, '盒'],
    [/\bBoxes\b/gi, '盒'],
    [/\bCan\b/gi, '罐'],
    [/\bCans\b/gi, '罐'],
    [/\bTube\b/gi, '支'],
    [/\bTubes\b/gi, '支'],
    [/\bBar\b/gi, '条'],
    [/\bBars\b/gi, '条'],
    [/\bTablet\b/gi, '片'],
    [/\bTablets\b/gi, '片'],
    [/\bCapsule\b/gi, '粒'],
    [/\bCapsules\b/gi, '粒'],
  ];
  for (const [re, rep] of rules) {
    s = s.replace(re, rep);
  }
  // "1 瓶装" -> "1瓶装" 等空格清理
  s = s.replace(/(\d+)\s+(瓶|罐|袋|盒|支|条|片|粒|件|盎司|毫升)/g, '$1$2');
  // 清理多余空格
  s = s.replace(/\s+/g, ' ').trim();
  // 繁体转简体
  s = t2s(s);
  return s;
}

/**
 * 解析所有SKU变体（名称 + 图片）
 */
function parseVariants($) {
  const variants = [];
  const seen = new Set();

  // 收集所有可能的变体图片：swatch、inline-twister、twister、a-button-toggle
  const selectors = [
    '.swatch-image-wrapper img',
    '[class*="swatch"] img',
    '.inline-twister-image img',
    '#twister img',
    '.a-button-toggle img',
    '.a-button-thumbnail img',
    '.image-swatch-button img',
    '[data-defaultasin] img',
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const alt = cleanText($(el).attr('alt') || '');
      const src = $(el).attr('src') || '';
      if (!alt || !src || !src.includes('/images/I/')) return;
      // 排除主图区域和视频缩略图
      if (src.includes('SY50') || src.includes('US40')) return;
      const m = src.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
      if (!m) return;
      const bid = m[1];
      if (seen.has(bid)) return;
      seen.add(bid);
      variants.push({
        name: translateVariant(alt),
        image: `https://m.media-amazon.com/images/I/${bid}._SL1500_.jpg`,
      });
    });
  }

  return variants;
}

/**
 * 解析价格详情：总价（含配送费+进口费）、单价、配送费、进口费
 * 优先取"总计"对应的价格
 */
function parsePriceDetail($) {
  let total = null, unit = null, shipping = null, importFee = null;

  // 方法1: apexPriceToPay 通常就是应付总价
  const apex = $('.apexPriceToPay .a-offscreen').first();
  if (apex.length) {
    const v = cleanText(apex.text());
    if (v && /\d/.test(v)) total = v;
  }

  // 方法2: 通过"總計/总计"等标签所在行找价格
  $('.a-color-secondary').each((_, el) => {
    const label = cleanText($(el).text());
    let key = null;
    if (/總計|总计/.test(label)) key = 'total';
    else if (/^價格$|^价格$/.test(label)) key = 'unit';
    else if (/配送/.test(label)) key = 'shipping';
    else if (/進口費用|进口费用|進口費|进口费/.test(label)) key = 'importFee';

    if (key) {
      const $row = $(el).closest('.a-row, tr');
      if (!$row.length) return;
      const priceEl = $row.find('.a-offscreen').first();
      if (!priceEl.length) return;
      const val = cleanText(priceEl.text());
      if (!val || !/\d/.test(val)) return;
      if (key === 'total' && !total) total = val;
      else if (key === 'unit' && !unit) unit = val;
      else if (key === 'shipping' && !shipping) shipping = val;
      else if (key === 'importFee' && !importFee) importFee = val;
    }
  });

  // 兜底：原来的单价选择器
  if (!unit) {
    const priceEl = $('.a-price .a-offscreen').first();
    if (priceEl.length) unit = cleanText(priceEl.text());
  }
  if (!total) total = unit;

  return { total, unit, shipping, importFee };
}

/**
 * 主采集流程
 */
async function scrape(productUrl) {
  const html = await fetchAmazon(productUrl);
  const $ = cheerio.load(html);

  const titleEl = $('#productTitle');
  const title = cleanText(t2s(titleEl.text().trim()));

  const priceDetail = parsePriceDetail($);

  const bullets = [];
  $('#feature-bullets li span').each((_, el) => {
    const txt = cleanText(t2s($(el).text().trim()));
    if (txt && !txt.startsWith('查看')) bullets.push(txt);
  });

  const images = parseImages($);
  const video = parseVideo(html);
  const brand = parseBrand($);
  const sku = parseSku($);
  const variants = parseVariants($);

  // 调试：检查 AmazonGlobal 上下文
  let amazonGlobalContext = '';
  const agIdx = html.indexOf('AmazonGlobal');
  if (agIdx >= 0) {
    amazonGlobalContext = html.slice(Math.max(0, agIdx - 200), agIdx + 300).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const hasCNY = html.includes('CNY') || html.includes('¥') || html.includes('￥');
  const hasUSD = html.includes('$');
  return { title, price: priceDetail.total, priceDetail, bullets, images, video, brand, sku, variants, url: productUrl, debug: { hasAmazonGlobal: agIdx >= 0, hasDelivery: html.includes('配送') || html.includes('遞送') || html.includes('運送'), hasTotal: html.includes('總計') || html.includes('总计'), hasCNY, hasUSD, amazonGlobalContext, priceDetail } };
}

// ==================== 路由 ====================

app.get('/', (req, res) => {
  res.type('html').send(INDEX_HTML);
});

// 调试：检查服务器出口IP区域
app.get('/api/debug_ip', async (req, res) => {
  try {
    const r = await axios.get('https://checkip.amazonaws.com/', { timeout: 10000 });
    const ip = (r.data || '').trim();
    res.json({ ip });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.post('/api/scrape', async (req, res) => {
  const productUrl = (req.body && req.body.url || '').trim();
  if (!productUrl || !productUrl.includes('amazon.')) {
    return res.status(400).json({ error: '请输入有效的亚马逊商品链接' });
  }
  try {
    const data = await scrape(productUrl);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 单张图片代理下载
app.get('/api/proxy_image', async (req, res) => {
  const imgUrl = (req.query.url || '').trim();
  if (!imgUrl || !imgUrl.includes('media-amazon.com')) {
    return res.status(400).json({ error: '无效的图片地址' });
  }
  try {
    const r = await axios.get(imgUrl, {
      headers: HEADERS,
      responseType: 'stream',
      timeout: 30000,
    });
    const name = path.basename(new URL(imgUrl).pathname) || 'image.jpg';
    res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    r.data.pipe(res);
  } catch (e) {
    res.status(500).json({ error: '图片下载失败: ' + e.message });
  }
});

// 一键下载所有图片（打包 zip）
app.post('/api/download_all_images', async (req, res) => {
  const images = (req.body && req.body.images) || [];
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: '没有可下载的图片' });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="amazon_product_images.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { res.status(500).end(); });
  archive.pipe(res);

  let idx = 1;
  for (const imgUrl of images) {
    try {
      const r = await axios.get(imgUrl, {
        headers: HEADERS,
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      const ext = (imgUrl.match(/\.(jpg|jpeg|png|webp)/i) || ['.jpg'])[1];
      const name = `image_${String(idx).padStart(2, '0')}.${ext}`;
      archive.append(Buffer.from(r.data), { name });
      idx++;
    } catch (e) {
      // 跳过失败的图片
    }
  }
  await archive.finalize();
});

// 视频 m3u8 -> mp4
app.post('/api/video', async (req, res) => {
  const m3u8 = (req.body && req.body.url || '').trim();
  if (!m3u8 || !m3u8.includes('.m3u8')) {
    return res.status(400).json({ error: '无效的视频地址' });
  }

  const outName = `${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`;
  const outPath = path.join(TMP_DIR, outName);

  const ffmpegPath = require('ffmpeg-static');

  const args = [
    '-y',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,httpproxy',
    '-i', m3u8,
    '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
    outPath,
  ];

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { stdio: 'ignore' });
      const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 300000);
      proc.on('error', reject);
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}`));
      });
    });
  } catch (e) {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    return res.status(500).json({ error: '视频转换失败' });
  }

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    return res.status(500).json({ error: '视频文件为空' });
  }

  res.download(outPath, 'amazon_product_video.mp4', (err) => {
    if (fs.existsSync(outPath)) {
      try { fs.unlinkSync(outPath); } catch (e) {}
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// ==================== 前端页面 ====================
const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>亚马逊商品信息采集工具</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f0f2f5; color: #1a1a1a; line-height: 1.6; }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
  header { text-align: center; margin-bottom: 24px; }
  header h1 { font-size: 26px; color: #232f3e; margin-bottom: 6px; }
  header p { color: #666; font-size: 14px; }
  .search-box { display: flex; gap: 10px; margin-bottom: 16px; }
  .search-box input { flex: 1; padding: 12px 16px; border: 1px solid #d0d0d0; border-radius: 8px; font-size: 15px; outline: none; transition: border .2s; }
  .search-box input:focus { border-color: #ff9900; box-shadow: 0 0 0 3px rgba(255,153,0,.15); }
  .search-box button { padding: 12px 28px; background: #ff9900; color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background .2s; white-space: nowrap; }
  .search-box button:hover { background: #e88a00; }
  .search-box button:disabled { background: #ccc; cursor: not-allowed; }

  /* 进度条 */
  .progress-wrap { display: none; background: #fff; border-radius: 12px; padding: 16px 20px; margin-bottom: 18px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .progress-wrap.active { display: block; }
  .progress-bar { width: 100%; height: 8px; background: #eee; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
  .progress-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #ff9900, #ff6b00); border-radius: 4px; transition: width .3s ease; }
  .progress-text { font-size: 13px; color: #666; }

  .card { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 18px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .field { margin-bottom: 16px; }
  .field:last-child { margin-bottom: 0; }
  .field-label { font-size: 13px; color: #888; margin-bottom: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
  .field-value { font-size: 16px; color: #222; word-break: break-word; min-height: 24px; }
  .field-value.placeholder { color: #bbb; font-style: italic; font-size: 14px; }
  .copy-btn { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; padding: 3px 10px; font-size: 12px; background: #eef2f7; color: #444; border: none; border-radius: 5px; cursor: pointer; transition: background .15s; vertical-align: middle; }
  .copy-btn:hover { background: #dfe6ef; }
  .copy-btn.copied { background: #28a745; color: #fff; }
  .bullets { padding-left: 4px; }
  .bullets li { margin-bottom: 8px; padding-left: 20px; position: relative; list-style: none; }
  .bullets li::before { content: "•"; position: absolute; left: 0; color: #ff9900; font-weight: bold; }
  .bullets.placeholder { color: #bbb; font-style: italic; }
  .media-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .media-header .field-label { margin-bottom: 0; }
  .download-all-btn { padding: 8px 18px; background: #232f3e; color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: background .15s; display: inline-flex; align-items: center; gap: 6px; }
  .download-all-btn:hover { background: #37475a; }
  .download-all-btn:disabled { background: #ccc; cursor: not-allowed; }
  .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 14px; min-height: 80px; }
  .media-grid.placeholder { color: #bbb; font-style: italic; display: flex; align-items: center; justify-content: center; }
  .media-item { position: relative; border-radius: 8px; overflow: hidden; background: #f7f7f7; aspect-ratio: 1; cursor: pointer; transition: transform .15s; }
  .media-item:hover { transform: translateY(-2px); }
  .media-item img { width: 100%; height: 100%; object-fit: contain; }
  .media-item .dl-overlay { position: absolute; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .15s; }
  .media-item:hover .dl-overlay { opacity: 1; }
  .dl-overlay span { color: #fff; font-size: 13px; font-weight: 600; }
  .video-card { display: flex; align-items: center; gap: 16px; padding: 14px; background: #f7f8fa; border-radius: 8px; margin-top: 16px; }
  .video-card.placeholder { color: #bbb; font-style: italic; justify-content: center; }
  .sku-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 14px; }
  .sku-grid.placeholder { color: #bbb; font-style: italic; display: flex; align-items: center; justify-content: center; min-height: 60px; }
  .sku-item { display: flex; flex-direction: column; gap: 8px; }
  .sku-item .sku-img { position: relative; border-radius: 8px; overflow: hidden; background: #f7f7f7; aspect-ratio: 1; cursor: pointer; transition: transform .15s; }
  .sku-item .sku-img:hover { transform: translateY(-2px); }
  .sku-item .sku-img img { width: 100%; height: 100%; object-fit: contain; }
  .sku-item .sku-img .dl-overlay { position: absolute; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .15s; }
  .sku-item .sku-img:hover .dl-overlay { opacity: 1; }
  .sku-item .sku-name { font-size: 13px; color: #444; text-align: center; word-break: break-word; line-height: 1.4; }
  .sku-item .sku-name .copy-btn { display: block; width: 100%; margin-top: 4px; }
  .video-thumb { width: 120px; height: 68px; background: #000; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 11px; flex-shrink: 0; overflow: hidden; }
  .video-thumb video { width: 100%; height: 100%; object-fit: cover; }
  .video-info { flex: 1; }
  .video-info .vtitle { font-weight: 600; margin-bottom: 4px; }
  .video-info .vmeta { font-size: 12px; color: #888; }
  .btn { padding: 8px 18px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 500; transition: all .15s; }
  .btn-primary { background: #ff9900; color: #fff; }
  .btn-primary:hover { background: #e88a00; }
  .btn-primary:disabled { background: #ccc; }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 10px 22px; border-radius: 20px; font-size: 14px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 999; }
  .toast.show { opacity: 1; }
  .error-msg { background: #fff5f5; color: #c53030; padding: 14px 18px; border-radius: 8px; border-left: 4px solid #c53030; }

  /* 错误指引卡片 */
  .error-guide { display: flex; gap: 14px; background: #fff; border-radius: 12px; padding: 20px 22px; margin-bottom: 18px; box-shadow: 0 1px 3px rgba(0,0,0,.06); border-left: 4px solid #ff9900; }
  .error-guide-icon { font-size: 32px; flex-shrink: 0; line-height: 1; }
  .error-guide-body { flex: 1; }
  .error-guide-title { font-size: 16px; font-weight: 700; color: #c53030; margin-bottom: 8px; }
  .error-guide-desc { font-size: 14px; color: #555; line-height: 1.7; margin-bottom: 14px; }
  .error-guide-desc code { background: #f0f2f5; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  .error-guide-actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .btn-secondary { background: #eef2f7; color: #333; }
  .btn-secondary:hover { background: #dfe6ef; }

  /* 价格详情 */
  .price-total { font-size: 22px; font-weight: 700; color: #c53030; }
  .price-breakdown { font-size: 13px; color: #888; margin-top: 6px; line-height: 1.8; }
  .price-breakdown .pb-row { display: flex; justify-content: space-between; max-width: 320px; }
  .price-breakdown .pb-total { font-weight: 700; color: #c53030; border-top: 1px dashed #ddd; padding-top: 4px; margin-top: 4px; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>📦 亚马逊商品信息采集工具</h1>
    <p>粘贴商品链接，一键采集主图、视频、标题、SKU、价格、品牌与商品介绍</p>
  </header>

  <div class="search-box">
    <input id="urlInput" type="text" placeholder="请输入亚马逊商品链接，例如 https://www.amazon.com/dp/xxxx" value="https://www.amazon.com/dp/B0F1TFC28B">
    <button id="scrapeBtn" onclick="doScrape()">开始采集</button>
  </div>

  <!-- 进度条 -->
  <div class="progress-wrap" id="progressWrap">
    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
    <div class="progress-text" id="progressText">准备中...</div>
  </div>

  <!-- 错误指引卡片 -->
  <div class="error-guide" id="errorGuide" style="display:none">
    <div class="error-guide-icon">⚠️</div>
    <div class="error-guide-body">
      <div class="error-guide-title" id="errorGuideTitle">采集失败</div>
      <div class="error-guide-desc" id="errorGuideDesc"></div>
      <div class="error-guide-actions">
        <button class="btn btn-primary" onclick="doScrape()">🔄 重新采集</button>
        <a class="btn btn-secondary" id="errorGuideLink" href="#" target="_blank" rel="noopener">🔗 打开商品页手动验证</a>
      </div>
    </div>
  </div>

  <!-- 基本信息 -->
  <div class="card">
    <div class="field">
      <div class="field-label">商品标题</div>
      <div class="field-value placeholder" id="fTitle">等待采集...</div>
    </div>
    <div class="field">
      <div class="field-label">品牌名称</div>
      <div class="field-value placeholder" id="fBrand">等待采集...</div>
    </div>
    <div class="field">
      <div class="field-label">SKU</div>
      <div class="field-value placeholder" id="fSku">等待采集...</div>
    </div>
    <div class="field">
      <div class="field-label">价格</div>
      <div class="field-value placeholder" id="fPrice">等待采集...</div>
    </div>
  </div>

  <!-- 关于此商品 -->
  <div class="card">
    <div class="field-label">关于此商品</div>
    <ul class="bullets placeholder" id="fBullets">等待采集...</ul>
  </div>

  <!-- 媒体 -->
  <div class="card">
    <div class="media-header">
      <div class="field-label">商品主图 / 视频</div>
      <button class="download-all-btn" id="dlAllBtn" onclick="downloadAllImages()" style="display:none">⬇ 一键下载全部图片</button>
    </div>
    <div class="media-grid placeholder" id="fImages">等待采集...</div>
    <div class="video-card placeholder" id="fVideo">暂无视频</div>
  </div>

  <!-- 其他SKU图片 -->
  <div class="card">
    <div class="field-label">其他SKU图片 <span style="font-weight:normal;color:#aaa;font-size:12px">（每个SKU图片可单独下载，下方文字可复制）</span></div>
    <div class="sku-grid placeholder" id="fSkuImages">等待采集...</div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let currentImages = [];
let progressTimer = null;

function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800);}

async function copyText(text,btn){
  if(!text){return;}
  let ok=false;
  // 优先 clipboard API
  try{
    if(navigator.clipboard && window.isSecureContext){
      await navigator.clipboard.writeText(text);
      ok=true;
    }
  }catch(e){}
  // fallback: textarea + execCommand
  if(!ok){
    try{
      const ta=document.createElement('textarea');
      ta.value=text;
      ta.style.cssText='position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok=document.execCommand('copy');
      document.body.removeChild(ta);
    }catch(e){}
  }
  // 再次 fallback: ClipboardItem
  if(!ok && window.ClipboardItem && navigator.clipboard){
    try{
      await navigator.clipboard.write([new ClipboardItem({'text/plain': new Blob([text], {type:'text/plain'})})]);
      ok=true;
    }catch(e){}
  }
  if(ok){
    if(btn){btn.classList.add('copied');btn.textContent='✓ 已复制';setTimeout(()=>{btn.classList.remove('copied');btn.innerHTML='📋 复制';},1500);}
    else toast('已复制');
  }else{
    // 最后兜底：弹出输入框让用户手动复制
    try{
      const ta=document.createElement('textarea');
      ta.value=text;
      ta.style.cssText='position:fixed;top:50%;left:50%;width:300px;height:100px;z-index:9999;padding:10px;';
      document.body.appendChild(ta);
      ta.select();
      toast('请手动复制（已选中）');
      setTimeout(()=>{if(ta.parentNode)ta.parentNode.removeChild(ta);},3000);
    }catch(e){toast('复制失败，请手动复制');}
  }
}

// 全局事件委托：处理所有 .copy-btn 点击
document.addEventListener('click', function(e){
  const btn = e.target.closest('.copy-btn');
  if(btn && btn.dataset.text !== undefined){
    e.preventDefault();
    copyText(btn.dataset.text, btn);
  }
});

function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// 设置字段值（带复制按钮）
function setField(id, value){
  const el = document.getElementById(id);
  if(!value){ el.textContent = '未采集到'; el.classList.add('placeholder'); return; }
  el.classList.remove('placeholder');
  const safe = escapeHtml(value);
  el.innerHTML = safe + '<button class="copy-btn" data-text="' + safe.replace(/"/g,'&quot;') + '">📋 复制</button>';
}

// 启动进度条
function startProgress(){
  const wrap = document.getElementById('progressWrap');
  const fill = document.getElementById('progressFill');
  const txt = document.getElementById('progressText');
  wrap.classList.add('active');
  let p = 0;
  fill.style.width = '0%';
  const stages = [
    {max:15, text:'正在连接亚马逊服务器...'},
    {max:45, text:'正在抓取商品页面...'},
    {max:80, text:'正在解析商品数据...'},
    {max:99, text:'正在整理结果...'},
  ];
  progressTimer = setInterval(()=>{
    p += 1.2;
    if(p > 99) p = 99;
    fill.style.width = p + '%';
    for(const s of stages){ if(p < s.max){ txt.textContent = s.text; break; } }
  }, 120);
}

function finishProgress(){
  if(progressTimer){ clearInterval(progressTimer); progressTimer = null; }
  const fill = document.getElementById('progressFill');
  const txt = document.getElementById('progressText');
  fill.style.width = '100%';
  txt.textContent = '采集完成';
  setTimeout(()=>{ document.getElementById('progressWrap').classList.remove('active'); }, 800);
}

function failProgress(msg){
  if(progressTimer){ clearInterval(progressTimer); progressTimer = null; }
  const fill = document.getElementById('progressFill');
  const txt = document.getElementById('progressText');
  fill.style.width = '100%';
  fill.style.background = '#c53030';
  txt.textContent = '采集失败: ' + msg;

  // 显示错误指引卡片
  const guide = document.getElementById('errorGuide');
  const title = document.getElementById('errorGuideTitle');
  const desc = document.getElementById('errorGuideDesc');
  const link = document.getElementById('errorGuideLink');
  const url = document.getElementById('urlInput').value.trim();
  link.href = url || '#';

  // 判断是否为验证码相关错误
  const isCaptcha = /验证码|validateCaptcha|status=200/i.test(msg || '');
  if(isCaptcha){
    title.textContent = '🛡️ 亚马逊触发了人机验证';
    desc.innerHTML = '这是亚马逊的反爬机制，并非工具故障。服务器已自动重试多次仍被拦截。<br>' +
      '建议按以下方式解决：<br>' +
      '1. 等待 <b>10~30 秒</b> 后点击「重新采集」；<br>' +
      '2. 或点击「打开商品页手动验证」，在新标签页中完成亚马逊验证码，然后回到本页重新采集。<br>' +
      '<span style="color:#888;font-size:12px">提示：频繁采集同一商品更容易触发验证，请适当间隔。</span>';
  } else {
    title.textContent = '采集失败';
    desc.textContent = msg || '未知错误，请检查链接是否正确后重试。';
  }
  guide.style.display = 'flex';
}

async function doScrape(){
  const url = document.getElementById('urlInput').value.trim();
  if(!url){ toast('请输入链接'); return; }
  // 隐藏上一次的错误指引
  document.getElementById('errorGuide').style.display = 'none';
  const btn = document.getElementById('scrapeBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 采集中...';
  // 重置进度条颜色
  document.getElementById('progressFill').style.background = 'linear-gradient(90deg, #ff9900, #ff6b00)';
  startProgress();
  // 把字段置为"采集中"状态
  ['fTitle','fBrand','fSku','fPrice'].forEach(id=>{
    const el=document.getElementById(id);
    el.textContent='采集中...'; el.classList.add('placeholder');
  });
  document.getElementById('fBullets').textContent='采集中...';
  document.getElementById('fImages').textContent='采集中...';
  document.getElementById('fVideo').textContent='采集中...';
  document.getElementById('fVideo').classList.add('placeholder');
  document.getElementById('fSkuImages').textContent='采集中...';
  document.getElementById('fSkuImages').classList.add('placeholder');
  document.getElementById('dlAllBtn').style.display='none';

  try{
    const resp = await fetch('/api/scrape',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    const json = await resp.json();
    if(!resp.ok || !json.ok){
      failProgress(json.error || '采集失败');
      return;
    }
    renderResult(json.data);
    finishProgress();
  }catch(e){
    failProgress(e.message);
  }finally{
    btn.disabled = false;
    btn.textContent = '重新采集';
  }
}

function renderResult(d){
  currentImages = d.images || [];
  // 基本信息
  setField('fTitle', d.title);
  setField('fBrand', d.brand);
  setField('fSku', d.sku);

  // 价格：优先显示总价（含配送+进口费），并展示明细
  const priceEl = document.getElementById('fPrice');
  const pd = d.priceDetail || {};
  const total = d.price || pd.total;
  if(total){
    priceEl.classList.remove('placeholder');
    const safeTotal = escapeHtml(total);
    let html = '<div class="price-total">' + safeTotal + '<button class="copy-btn" data-text="' + safeTotal.replace(/"/g,'&quot;') + '">📋 复制</button></div>';
    // 明细
    const rows = [];
    if(pd.unit) rows.push(['单价', pd.unit]);
    if(pd.shipping) rows.push(['配送费', pd.shipping]);
    if(pd.importFee) rows.push(['进口费', pd.importFee]);
    if(rows.length){
      let bd = '<div class="price-breakdown">';
      rows.forEach(r=>{ bd += '<div class="pb-row"><span>'+escapeHtml(r[0])+'</span><span>'+escapeHtml(r[1])+'</span></div>'; });
      bd += '<div class="pb-row pb-total"><span>总计</span><span>'+safeTotal+'</span></div>';
      bd += '</div>';
      html += bd;
    }
    priceEl.innerHTML = html;
  } else {
    priceEl.textContent = '未采集到';
    priceEl.classList.add('placeholder');
  }

  // 关于此商品
  const bulletsEl = document.getElementById('fBullets');
  if(d.bullets && d.bullets.length){
    bulletsEl.classList.remove('placeholder');
    const allText = d.bullets.join('\\n');
    const safeAll = escapeHtml(allText).replace(/"/g,'&quot;');
    let html = '<li style="margin-bottom:10px"><button class="copy-btn" data-text="' + safeAll + '">📋 复制全部</button></li>';
    d.bullets.forEach(b=>{ html += '<li>' + escapeHtml(b) + '</li>'; });
    bulletsEl.innerHTML = html;
  } else {
    bulletsEl.textContent = '未采集到';
    bulletsEl.classList.add('placeholder');
  }

  // 图片
  const imgEl = document.getElementById('fImages');
  if(currentImages.length){
    imgEl.classList.remove('placeholder');
    let html = '';
    currentImages.forEach((src,i)=>{
      const dl = '/api/proxy_image?url=' + encodeURIComponent(src);
      html += '<a class="media-item" href="'+dl+'" download><img src="'+src+'" alt="主图'+(i+1)+'" loading="lazy" onerror="this.style.opacity=.3"><div class="dl-overlay"><span>⬇ 下载</span></div></a>';
    });
    imgEl.innerHTML = html;
    document.getElementById('dlAllBtn').style.display = 'inline-flex';
  } else {
    imgEl.textContent = '未采集到图片';
    imgEl.classList.add('placeholder');
    document.getElementById('dlAllBtn').style.display = 'none';
  }

  // 视频
  const vidEl = document.getElementById('fVideo');
  if(d.video){
    vidEl.classList.remove('placeholder');
    vidEl.innerHTML = '<div class="video-thumb"><video src="'+d.video.master+'" muted playsinline preload="metadata"></video></div><div class="video-info"><div class="vtitle">主图视频</div><div class="vmeta">点击下方按钮下载为 MP4 文件</div></div><button class="btn btn-primary" onclick="downloadVideo(\\''+d.video.stream720+'\\', this)">⬇ 下载视频</button>';
  } else {
    vidEl.textContent = '暂无视频';
    vidEl.classList.add('placeholder');
  }

  // 其他SKU图片
  const skuEl = document.getElementById('fSkuImages');
  if(d.variants && d.variants.length){
    skuEl.classList.remove('placeholder');
    let html = '';
    d.variants.forEach((v,i)=>{
      const dl = '/api/proxy_image?url=' + encodeURIComponent(v.image);
      const safeName = escapeHtml(v.name);
      const dataText = safeName.replace(/"/g,'&quot;');
      html += '<div class="sku-item">';
      html += '<a class="sku-img" href="'+dl+'" download><img src="'+v.image+'" alt="'+safeName+'" loading="lazy" onerror="this.style.opacity=.3"><div class="dl-overlay"><span>⬇ 下载</span></div></a>';
      html += '<div class="sku-name">'+safeName+'<button class="copy-btn" data-text="'+dataText+'">📋 复制</button></div>';
      html += '</div>';
    });
    skuEl.innerHTML = html;
  } else {
    skuEl.textContent = '该商品无其他SKU变体';
    skuEl.classList.add('placeholder');
  }
}

// 一键下载全部图片（使用 File System Access API，选择一次目录保存所有图片）
async function downloadAllImages(){
  if(!currentImages.length){ toast('没有可下载的图片'); return; }
  const btn = document.getElementById('dlAllBtn');
  btn.disabled = true;
  const origText = btn.innerHTML;

  // 优先使用 File System Access API（用户选择一次目录，所有图片直接写入）
  if(window.showDirectoryPicker){
    try{
      const dirHandle = await window.showDirectoryPicker();
      let success = 0;
      for(let i = 0; i < currentImages.length; i++){
        btn.innerHTML = '<span class="spinner"></span> 保存中 ' + (i+1) + '/' + currentImages.length;
        try{
          const src = currentImages[i];
          const dlUrl = '/api/proxy_image?url=' + encodeURIComponent(src);
          const resp = await fetch(dlUrl);
          if(!resp.ok) continue;
          const blob = await resp.blob();
          const ext = (src.match(/\\.(jpg|jpeg|png|webp)/i) || ['jpg'])[1];
          const fileName = 'image_' + String(i+1).padStart(2,'0') + '.' + ext;
          const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          success++;
        }catch(e){}
      }
      btn.disabled = false;
      btn.innerHTML = origText;
      toast('已保存 ' + success + ' 张图片到所选文件夹');
      return;
    }catch(e){
      // 用户取消选择目录或其他错误，回退到逐个下载
      if(e.name === 'AbortError'){ btn.disabled=false; btn.innerHTML=origText; return; }
    }
  }

  // 回退方案：逐个下载（浏览器会保存到默认下载目录）
  let success = 0;
  for(let i = 0; i < currentImages.length; i++){
    btn.innerHTML = '<span class="spinner"></span> 下载中 ' + (i+1) + '/' + currentImages.length;
    try{
      const src = currentImages[i];
      const dlUrl = '/api/proxy_image?url=' + encodeURIComponent(src);
      const resp = await fetch(dlUrl);
      if(!resp.ok) continue;
      const blob = await resp.blob();
      const ext = (src.match(/\\.(jpg|jpeg|png|webp)/i) || ['jpg'])[1];
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'image_' + String(i+1).padStart(2,'0') + '.' + ext;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
      success++;
    }catch(e){}
    await new Promise(r=>setTimeout(r, 400));
  }
  btn.disabled = false;
  btn.innerHTML = origText;
  toast('已下载 ' + success + ' 张图片');
}

async function downloadVideo(m3u8, btn){
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 转换中...';
  try{
    const resp = await fetch('/api/video',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:m3u8})});
    if(!resp.ok){ const j=await resp.json().catch(()=>({})); toast(j.error||'下载失败'); btn.disabled=false; btn.textContent='⬇ 下载视频'; return; }
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'amazon_product_video.mp4';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('视频下载完成');
  }catch(e){ toast('下载失败: '+e.message); }
  finally{ btn.disabled=false; btn.textContent='⬇ 下载视频'; }
}

document.getElementById('urlInput').addEventListener('keydown', e=>{ if(e.key==='Enter') doScrape(); });
</script>
</body>
</html>`;
