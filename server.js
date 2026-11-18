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

// 多个真实浏览器 UA 轮换
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

function buildHeaders() {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const isWin = ua.includes('Windows');
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': isWin ? '"Windows"' : '"macOS"',
  };
}

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
 * 抓取亚马逊商品页面（直接获取源码，不走验证流程）
 */
async function fetchAmazon(productUrl) {
  // 规范化 URL，强制 zh_CN + CNY，配送至中国
  const parsed = new URL(productUrl);
  parsed.searchParams.set('language', 'zh_CN');
  parsed.searchParams.set('currency', 'CNY');
  parsed.searchParams.set('shipToCountry', 'CN');
  const cleanUrl = parsed.toString();

  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const headers = buildHeaders();
      const instance = axios.create({
        headers,
        maxRedirects: 5,
        timeout: 30000,
        decompress: true,
        withCredentials: true,
      });

      // 预热：访问主页获取 cookie
      let cookieHeader = '';
      try {
        const warmup = await instance.get('https://www.amazon.com/', { timeout: 12000 });
        const setCookies = warmup.headers['set-cookie'];
        if (Array.isArray(setCookies) && setCookies.length) {
          cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');
        }
        await new Promise(r => setTimeout(r, 800 + attempt * 400));
      } catch (e) { /* ignore warmup failure */ }

      const prodHeaders = { ...headers };
      prodHeaders['Referer'] = 'https://www.amazon.com/';
      if (cookieHeader) prodHeaders['Cookie'] = cookieHeader;
      const r = await instance.get(cleanUrl, { headers: prodHeaders });
      if (r.status === 200 && !r.data.includes('validateCaptcha') && !r.data.includes('Type the characters')) {
        return r.data;
      }
      lastErr = `status=${r.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise(r => setTimeout(r, 1200 + attempt * 800));
  }
  throw new Error(`请求失败（${lastErr}），请稍后重试`);
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

/**
 * 解析商品尺寸/规格信息（优先返回变体规格，保留英文原文如 "1.38 Ounce (Pack of 50)"）
 */
function parseDimensions($) {
  // 1. 优先返回当前选中的变体规格（如 "1.38 Ounce (Pack of 50)"）
  const selected = parseSelectedVariant($);
  if (selected) return selected;

  // 2. 从标题中提取规格信息
  const titleEl = $('#productTitle');
  const titleText = cleanText(titleEl.text().trim());
  const specMatch = titleText.match(/(\d+\.?\d*)\s*(Ounce|Ounces|oz|ml|mL|gram|grams|pound|pounds|lb|lbs|bottle|bottles|jar|jars|bag|bags|box|boxes|can|cans|pack|packs|count|ct)/gi);
  if (specMatch && specMatch.length) {
    return specMatch.join(' ');
  }

  // 3. 兜底：Item Weight
  const itemWeight = parseDetailRow($, ['Item Weight', '商品重量', '物品重量', '產品重量']);
  if (itemWeight) return itemWeight;

  // 4. 商品尺寸
  const dimensions = parseDetailRow($, ['Product Dimensions', '商品尺寸', '產品尺寸', '尺寸']);
  if (dimensions) return dimensions;

  return null;
}

/**
 * 解析当前选中的变体名称（保留英文原文）
 */
function parseSelectedVariant($) {
  // 1. 遍历所有 a-button-selected 内的图片，找第一个有 alt 的
  const selImgs = $('.a-button-selected img').toArray();
  for (const el of selImgs) {
    const alt = cleanText($(el).attr('alt') || '');
    if (alt) return alt;
  }
  // 2. aria-pressed=true 的按钮
  const pressed = $('[aria-pressed="true"] img').toArray();
  for (const el of pressed) {
    const alt = cleanText($(el).attr('alt') || '');
    if (alt) return alt;
  }
  // 3. 下拉选择框中选中的 option
  const selSelects = $('select#variation_size_name option:checked, select[name*="size_name"] option:checked, select[name*="variation"] option:checked').toArray();
  for (const el of selSelects) {
    const txt = cleanText($(el).text());
    if (txt && txt !== '--选择--' && txt !== '--Select--' && !/请选择|Select/i.test(txt)) {
      return txt;
    }
  }
  // 4. 遍历所有 a-button-selected，找第一个有有效文本的
  const selBtns = $('.a-button-selected').toArray();
  for (const el of selBtns) {
    const txt = cleanText($(el).text());
    if (txt && txt.length > 0 && txt.length < 80) return txt;
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
 * 提取页面中某个 JSON 对象（按平衡花括号匹配）
 */
function extractJsonObject(html, key) {
  const start = html.indexOf(key);
  if (start < 0) return null;
  const objStart = html.indexOf('{', start + key.length);
  if (objStart < 0) return null;
  let depth = 0, end = -1;
  for (let i = objStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(html.slice(objStart, end + 1)); } catch (e) { return null; }
}

/**
 * 提取页面中某个 JSON 数组（按平衡方括号匹配）
 */
function extractJsonArray(html, key) {
  const start = html.indexOf(key);
  if (start < 0) return null;
  const arrStart = html.indexOf('[', start + key.length);
  if (arrStart < 0) return null;
  let depth = 0, end = -1;
  for (let i = arrStart; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(html.slice(arrStart, end + 1)); } catch (e) { return null; }
}

/**
 * 从页面 HTML 中解析 colorImages，返回变体名称 -> 高清图片URL数组 的映射
 * 每个变体可能有多张图，全部收集（hiRes 优先，large 兜底）
 */
function parseColorImages(html) {
  const map = {};
  // 尝试多种键名格式
  let colorImages = extractJsonObject(html, '"colorImages":') || extractJsonObject(html, "'colorImages':") || extractJsonObject(html, 'colorImages:');
  if (!colorImages) return map;
  for (const [variantName, imgs] of Object.entries(colorImages)) {
    if (!Array.isArray(imgs)) continue;
    const urls = [];
    for (const img of imgs) {
      if (!img) continue;
      if (img.hiRes) urls.push(img.hiRes);
      else if (img.large) urls.push(img.large);
    }
    if (urls.length) map[variantName] = urls;
  }
  return map;
}

/**
 * 从图片对象中提取高清 URL（hiRes 优先，large 兜底）
 */
function imgUrl(img) {
  if (!img) return null;
  return img.hiRes || img.large || null;
}

/**
 * 从 imageGalleryData 中提取画廊全部高清原图（页面"查看完整视图"展示的图）
 * 兼容数组格式和对象包裹数组格式
 */
function parseImageGalleryData(html) {
  const urls = [];
  const key = 'imageGalleryData';
  let pos = 0;
  while ((pos = html.indexOf(key, pos)) !== -1) {
    // 跳过关键词后的引号、冒号、等号、空白
    let i = pos + key.length;
    while (i < html.length && /[\s'":=]/.test(html[i])) i++;
    let end = -1;
    let isArray = false;
    if (html[i] === '[') {
      isArray = true;
      let depth = 0;
      for (let j = i; j < html.length; j++) {
        if (html[j] === '[') depth++;
        else if (html[j] === ']') { depth--; if (depth === 0) { end = j; break; } }
      }
    } else if (html[i] === '{') {
      // 对象格式，可能包含 images 数组或直接是图片对象
      let depth = 0;
      for (let j = i; j < html.length; j++) {
        if (html[j] === '{') depth++;
        else if (html[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
    }
    if (end < 0) { pos = i; continue; }
    try {
      const data = JSON.parse(html.slice(i, end + 1));
      if (Array.isArray(data)) {
        for (const item of data) { const u = imgUrl(item); if (u) urls.push(u); }
      } else if (data && typeof data === 'object') {
        // 可能是 {images: [...]} 或直接是图片对象
        if (Array.isArray(data.images)) {
          for (const item of data.images) { const u = imgUrl(item); if (u) urls.push(u); }
        } else {
          const u = imgUrl(data); if (u) urls.push(u);
        }
      }
    } catch (e) { /* ignore */ }
    pos = end + 1;
  }
  return urls;
}

/**
 * 从整个 HTML 中正则提取所有 hiRes 高清原图 URL
 * 覆盖 colorImages / imageGalleryData / 其他内联数据中的全部 hiRes 字段
 */
function parseAllHiResImages(html) {
  const urls = [];
  const re = /"hiRes"\s*:\s*"(https?:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    urls.push(m[1].replace(/\\\//g, '/'));
  }
  return urls;
}

/**
 * 解析所有SKU变体（名称 + 图片）
 */
function parseVariants($) {
  const variants = [];
  const seen = new Set();

  // 只在"变体选择容器"内扫描，避免把 #altImages 画廊缩略图误判为变体
  // 亚马逊变体选择器通常位于这些容器中
  const variantContainerSel = [
    '#twister',
    '.inline-twister',
    '.inline-twister-swatch',
    '.swatch',
    '.swatch-list',
    '#variation_size_name',
    '#variation_color_name',
    '#variation_style_name',
    '#variation_item_package_quantity',
    '[data-defaultasin]',
  ].join(', ');

  const $vc = $(variantContainerSel);

  // 1. 图片式变体（颜色/样式选择的小图，带 alt 文本）
  $vc.find('img').each((_, el) => {
    const alt = cleanText($(el).attr('alt') || '');
    const src = $(el).attr('src') || '';
    if (!alt || !src || !src.includes('/images/I/')) return;
    if (src.includes('SY50') || src.includes('US40')) return;
    const m = src.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
    if (!m) return;
    const bid = m[1];
    if (seen.has(alt)) return;
    seen.add(alt);
    variants.push({
      name: alt,
      image: `https://m.media-amazon.com/images/I/${bid}._SL1500_.jpg`,
    });
  });

  // 2. 文本按钮式变体（规格按钮，如 "5.32 Ounce (Pack of 2)"）
  // 与图片式同时检测、用 seen 去重，支持同时有颜色+规格的商品
  $vc.find('.a-button, .a-button-toggle, .swatch-element, .a-button-text').each((_, el) => {
    const $btn = $(el);
    // 跳过已禁用（不可选）的按钮
    if ($btn.hasClass('a-button-disabled')) return;
    // 跳过仅作为容器的按钮（如外层包裹），需要有实际文本
    const txt = cleanText($btn.clone().find('span.a-icon-text').remove().end().text());
    if (!txt || txt.length > 80) return;
    if (seen.has(txt)) return;
    // 尝试从按钮内找图片（img 标签或 data 属性）
    let img = '';
    const imgEl = $btn.find('img').first();
    let src = imgEl.attr('src') || imgEl.attr('data-old-hires') || '';
    // 尝试从按钮的 data-a-dynamic-image 中解析
    if (!src) {
      const dynamic = $btn.find('[data-a-dynamic-image]').first().attr('data-a-dynamic-image') || $btn.attr('data-a-dynamic-image') || '';
      if (dynamic) {
        try {
          const imgObj = JSON.parse(dynamic);
          const keys = Object.keys(imgObj);
          if (keys.length) src = keys[0];
        } catch (e) { /* ignore */ }
      }
    }
    // 尝试 data-src / data-image
    if (!src) src = $btn.find('[data-src]').first().attr('data-src') || $btn.attr('data-src') || '';
    if (src && src.includes('/images/I/')) {
      const m = src.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
      if (m) img = `https://m.media-amazon.com/images/I/${m[1]}._SL1500_.jpg`;
    }
    seen.add(txt);
    variants.push({ name: txt, image: img });
  });

  // 3. 下拉选择框式变体（兜底，仅在未找到任何按钮式变体时使用）
  if (variants.length === 0) {
    $('select#variation_size_name option, select[name*="size_name"] option, select[name*="variation"] option').each((_, el) => {
      const txt = cleanText($(el).text());
      if (!txt || /请选择|Select|--/i.test(txt)) return;
      if (seen.has(txt)) return;
      seen.add(txt);
      variants.push({ name: txt, image: '' });
    });
  }

  // 4. 如果变体列表位于折叠的 expander 内（"查看更多" aria-expanded=false），
  //    说明页面默认只显示前几项，其余需点击展开。此时只保留前 3 个（与页面默认可见数一致）
  const expanderContent = $('.dimension-expander-content, [id^="inline-twister-expander-content"]')
    .has('.inline-twister-swatch, .swatch, .a-button-toggle')
    .first();
  if (expanderContent.length) {
    const expanderId = expanderContent.attr('id') || '';
    let toggle = null;
    if (expanderId) {
      toggle = $(`[data-a-expander-toggle][aria-controls="${expanderId}"]`).first();
    }
    if (!toggle || !toggle.length) {
      const row = expanderContent.closest('.inline-twister-row, .a-section, .a-row').first();
      toggle = row.find('[data-a-expander-toggle]').first();
    }
    if (!toggle || !toggle.length) {
      toggle = $('[data-a-expander-toggle][aria-expanded="false"]').first();
    }
    if (toggle && toggle.length && String(toggle.attr('aria-expanded')) === 'false') {
      variants.length = Math.min(variants.length, 3);
    }
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

  const video = parseVideo(html);
  const brand = parseBrand($);
  const dimensions = parseDimensions($);

  // 从 colorImages 中获取变体名称 -> 高清图片数组 的映射（名称为英文原文）
  const colorImages = parseColorImages(html);

  // 主图：采集"查看完整视图"画廊中的全部高清原图
  // 方案：hiRes 排除变体专属图 为主（这是最权威的数据源，顺序即 colorImages.initial 原始顺序）
  //       #altImages 仅做兜底补充（当 hiRes 因 CAPTCHA 变少或重复时）
  //       截断时按权威顺序直接切前 8 张，不能用 altImages 反过来覆盖 hiRes
  const galleryImgs = [];
  const seenImgIds = new Set();
  const addImg = (url) => {
    if (!url) return;
    const m = url.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
    const id = m ? m[1] : url;
    if (seenImgIds.has(id)) return;
    seenImgIds.add(id);
    galleryImgs.push(url);
  };
  // hiRes 图 ID -> URL 映射
  const hiResById = new Map();
  for (const u of parseAllHiResImages(html)) {
    const m = u.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
    if (m) hiResById.set(m[1], u);
  }
  // 所有变体图 ID（colorImages 各变体 key 下的专属主图）
  const allVariantImgIds = new Set();
  for (const [variantName, urls] of Object.entries(colorImages)) {
    // 跳过 "initial" —— 那是公共画廊，不是某个具体变体的专属图
    if (variantName === 'initial') continue;
    for (const u of urls) {
      const m = u.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
      if (m) {
        allVariantImgIds.add(m[1]);
        if (!hiResById.has(m[1])) hiResById.set(m[1], u);
      }
    }
  }
  // 源1. hiRes 排除变体专属图 —— 这是主图顺序的权威来源
  for (const u of parseAllHiResImages(html)) {
    const m = u.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
    const id = m ? m[1] : u;
    if (allVariantImgIds.has(id)) continue;
    addImg(u);
  }
  // 源2. #altImages 仅做兜底补充 —— 当 hiRes 被截断时补漏
  $('#altImages img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src.includes('/images/I/')) return;
    if (/\/video\//i.test(src)) return;
    const m = src.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
    if (!m) return;
    const imgId = m[1];
    const hiRes = hiResById.get(imgId);
    if (hiRes) addImg(hiRes);
    else addImg(`https://m.media-amazon.com/images/I/${imgId}._SL1500_.jpg`);
  });

  // 截断：权威顺序就是 hiRes 过滤后的顺序，直接切前 8 张
  // 之前的错误逻辑是"优先保留 altImages 映射到的图"，但 altImages 缩略图 ID 与
  // colorImages.initial 里的 hiRes ID 完全不同，会把真正的画廊图（如品牌宣传图）挤掉
  if (galleryImgs.length > 8) {
    galleryImgs.length = 8;
  }
  // 兜底
  if (galleryImgs.length === 0) {
    let selectedImgs = null;
    if (dimensions) {
      const dimStr = String(dimensions);
      selectedImgs = colorImages[dimStr] || null;
      if (!selectedImgs) {
        const dimLower = dimStr.toLowerCase();
        for (const [name, urls] of Object.entries(colorImages)) {
          const nl = name.toLowerCase();
          if (nl === dimLower || nl.includes(dimLower) || dimLower.includes(nl)) {
            selectedImgs = urls; break;
          }
        }
      }
    }
    if (selectedImgs) selectedImgs.forEach(addImg);
    for (const u of parseAllHiResImages(html)) addImg(u);
    $('#altImages img').each((_, el) => {
      const src = $(el).attr('src') || '';
      const m = src.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
      if (m) addImg(`https://m.media-amazon.com/images/I/${m[1]}._SL1500_.jpg`);
    });
    if (galleryImgs.length === 0) parseImages($).forEach(addImg);
  }

  const images = galleryImgs;
  const fallbackImg = (images && images[0]) ? images[0] : '';

  // 其他SKU：colorImages 的 key 就是页面"尺寸规格"选择器的完整权威列表
  // （亚马逊 JS 框架生成，顺序就是页面显示顺序，每个 key 对应一个变体 hiRes 图）
  // 直接用 colorImages 生成变体，不再依赖 DOM 扫描（DOM 容易嵌套重复、展开/折叠状态不一致）
  // 排除 "initial" key —— 那是公共画廊不是变体
  let variants = [];
  if (Object.keys(colorImages).length > 0) {
    for (const [variantName, urls] of Object.entries(colorImages)) {
      if (variantName === 'initial') continue;
      const img = (urls && urls[0]) || fallbackImg;
      variants.push({ name: variantName, image: img });
    }
  } else {
    // 兜底：colorImages 不可用时才回退到 DOM 扫描
    variants = parseVariants($);
    variants.forEach(v => { if (!v.image) v.image = fallbackImg; });
  }

  return { title, price: priceDetail.total, priceDetail, bullets, images, video, brand, dimensions, variants, url: productUrl };
}

// ==================== 路由 ====================

app.get('/', (req, res) => {
  res.type('html').send(INDEX_HTML);
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

// 临时调试接口：检查页面图片数据结构
app.post('/api/debug-images', async (req, res) => {
  const productUrl = (req.body && req.body.url || '').trim();
  if (!productUrl || !productUrl.includes('amazon.')) {
    return res.status(400).json({ error: '无效链接' });
  }
  try {
    const html = await fetchAmazon(productUrl);
    const $ = cheerio.load(html);
    const colorImages = parseColorImages(html);
    const galleryData = parseImageGalleryData(html);
    const allHiRes = parseAllHiResImages(html);
    const altImgs = [];
    $('#altImages img').each((_, el) => {
      const src = $(el).attr('src') || '';
      const m = src.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
      altImgs.push(m ? m[1] : src);
    });
    const dim = parseDimensions($);
    let selImgs = [];
    if (dim && colorImages[dim]) selImgs = colorImages[dim];
    const colorKeys = {};
    for (const [k, v] of Object.entries(colorImages)) colorKeys[k] = v.length;
    const allHiResIds = allHiRes.map(u => { const m = u.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/); return m ? m[1] : u; });
    res.json({
      ok: true,
      dimensions: dim,
      colorImagesKeys: colorKeys,
      galleryDataCount: galleryData.length,
      allHiResCount: allHiRes.length,
      allHiResIds,
      altImagesIds: altImgs,
      selectedImgs: selImgs.map(u => { const m = u.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/); return m ? m[1] : u; }),
      hasImageGalleryData: html.includes('imageGalleryData'),
      hasColorImages: html.includes('colorImages'),
    });
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
      headers: buildHeaders(),
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
        headers: buildHeaders(),
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
      <div class="field-label">尺寸/规格</div>
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
      <div class="field-label">商品主图 / 视频 <label style="margin-left:12px;font-weight:normal;color:#aaa;font-size:12px;cursor:pointer"><input type="checkbox" id="selAll" checked onchange="toggleSelAll(this.checked)" style="margin-right:4px">全选 / 全不选</label></div>
      <div style="display:flex;gap:8px">
        <button class="download-all-btn" id="dlSelBtn" onclick="downloadSelectedImages()" style="display:none">⬇ 下载选中图片</button>
        <button class="download-all-btn" id="dlAllBtn" onclick="downloadAllImages()" style="display:none">⬇ 下载全部图片</button>
      </div>
    </div>
    <div class="media-grid placeholder" id="fImages">等待采集...</div>
    <div class="video-card placeholder" id="fVideo">暂无视频</div>
  </div>

  <!-- 其他SKU图片 -->
  <div class="card">
    <div class="media-header">
      <div class="field-label">其他SKU图片 <span style="font-weight:normal;color:#aaa;font-size:12px;cursor:pointer;margin-left:12px"><label style="cursor:pointer"><input type="checkbox" id="selAllSku" checked onchange="toggleSelAllSku(this.checked)" style="margin-right:4px">全选 / 全不选</label></span></div>
    </div>
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

  // 判断是否为请求失败/验证码
  const isFail = /验证码|validateCaptcha|status=200|timeout|失败|请求失败/i.test(msg || '');
  if(isFail){
    title.textContent = '🛡️ 采集失败，请稍后重试';
    desc.innerHTML = '服务器请求亚马逊时被拦截或超时，这是亚马逊的反爬机制。<br>' +
      '请等待 <b>30~60 秒</b> 后点击「重新采集」，或换个商品链接再试。';
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
  setField('fSku', d.dimensions);

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
  const selAllCk = document.getElementById('selAll');
  if(currentImages.length){
    imgEl.classList.remove('placeholder');
    let html = '';
    currentImages.forEach((src,i)=>{
      const dl = '/api/proxy_image?url=' + encodeURIComponent(src);
      html += '<div class="media-item-wrap" style="position:relative">';
      html += '<a class="media-item" href="'+dl+'" download><img src="'+src+'" alt="主图'+(i+1)+'" loading="lazy" onerror="this.style.opacity=.3"><div class="dl-overlay"><span>⬇ 下载</span></div></a>';
      html += '<input type="checkbox" class="img-sel" data-idx="'+i+'" checked onchange="updateSelBtn()" style="position:absolute;top:6px;left:6px;z-index:10;width:18px;height:18px;cursor:pointer">';
      html += '</div>';
    });
    imgEl.innerHTML = html;
    selAllCk.checked = true;
    document.getElementById('dlSelBtn').style.display = 'inline-flex';
    document.getElementById('dlAllBtn').style.display = 'inline-flex';
  } else {
    imgEl.textContent = '未采集到图片';
    imgEl.classList.add('placeholder');
    document.getElementById('dlSelBtn').style.display = 'none';
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
  const selAllSku = document.getElementById('selAllSku');
  if(d.variants && d.variants.length){
    skuEl.classList.remove('placeholder');
    let html = '';
    d.variants.forEach((v,i)=>{
      const safeName = escapeHtml(v.name);
      const dataText = safeName.replace(/"/g,'&quot;');
      html += '<div class="sku-item">';
      if(v.image){
        const dl = '/api/proxy_image?url=' + encodeURIComponent(v.image);
        html += '<div style="position:relative;display:inline-block">';
        html += '<a class="sku-img" href="'+dl+'" download><img src="'+v.image+'" alt="'+safeName+'" loading="lazy" onerror="this.style.opacity=.3"><div class="dl-overlay"><span>⬇ 下载</span></div></a>';
        html += '<input type="checkbox" class="sku-img-sel" data-src="'+v.image+'" checked onchange="updateSelBtn()" style="position:absolute;top:6px;left:6px;z-index:10;width:16px;height:16px;cursor:pointer">';
        html += '</div>';
      } else {
        html += '<div class="sku-img" style="display:flex;align-items:center;justify-content:center;background:#f0f0f0;color:#999;font-size:13px;">无图片</div>';
      }
      html += '<div class="sku-name">'+safeName+'<button class="copy-btn" data-text="'+dataText+'">📋 复制</button></div>';
      html += '</div>';
    });
    skuEl.innerHTML = html;
    if (selAllSku) selAllSku.checked = true;
  } else {
    skuEl.textContent = '该商品无其他SKU变体';
    skuEl.classList.add('placeholder');
    if (selAllSku) selAllSku.checked = false;
  }
}

// 一键下载全部图片（主图 + 所有有图的 SKU，去重）
async function downloadAllImages(){
  const main = currentImages.slice();
  const skuUrls = [];
  document.querySelectorAll('.sku-img-sel').forEach(c => { if(c.dataset.src) skuUrls.push(c.dataset.src); });
  const seen = new Set();
  const all = [];
  for (const u of [...main, ...skuUrls]) {
    const m = u.match(/\\/images\\/I\\/([A-Za-z0-9+\\-]+)\\._/);
    const id = m ? m[1] : u;
    if (!seen.has(id)) { seen.add(id); all.push(u); }
  }
  await downloadImageList(all, document.getElementById('dlAllBtn'));
}

// ============ 勾选下载 ============
// 主图勾选
function getSelectedMainImages(){
  const checks = document.querySelectorAll('.img-sel');
  const urls = [];
  checks.forEach(c => { if(c.checked){ const idx = parseInt(c.dataset.idx,10); if(!isNaN(idx) && currentImages[idx]) urls.push(currentImages[idx]); } });
  return urls;
}
// SKU 勾选
function getSelectedSkuImages(){
  const checks = document.querySelectorAll('.sku-img-sel');
  const urls = [];
  checks.forEach(c => { if(c.checked && c.dataset.src) urls.push(c.dataset.src); });
  return urls;
}
// 合并勾选（主图 + SKU，去重）
function getSelectedImages(){
  const main = getSelectedMainImages();
  const sku = getSelectedSkuImages();
  const seen = new Set();
  const merged = [];
  for (const u of [...main, ...sku]) {
    const m = u.match(/\\/images\\/I\\/([A-Za-z0-9+\\-]+)\\._/);
    const id = m ? m[1] : u;
    if (!seen.has(id)) { seen.add(id); merged.push(u); }
  }
  return merged;
}
function toggleSelAll(checked){
  document.querySelectorAll('.img-sel').forEach(c => c.checked = checked);
  const cb = document.getElementById('selAll'); if(cb) cb.checked = checked;
  updateSelBtn();
}
function toggleSelAllSku(checked){
  document.querySelectorAll('.sku-img-sel').forEach(c => c.checked = checked);
  const cb = document.getElementById('selAllSku'); if(cb) cb.checked = checked;
  updateSelBtn();
}
function updateSelBtn(){
  const mainAll = document.querySelectorAll('.img-sel').length;
  const mainSel = document.querySelectorAll('.img-sel:checked').length;
  const skuAll = document.querySelectorAll('.sku-img-sel').length;
  const skuSel = document.querySelectorAll('.sku-img-sel:checked').length;
  const totalSel = mainSel + skuSel;
  const btn = document.getElementById('dlSelBtn');
  if(!btn) return;
  btn.style.display = (mainAll + skuAll > 0) ? 'inline-flex' : 'none';
  btn.textContent = '⬇ 下载选中 (' + totalSel + ')';
  const selAll = document.getElementById('selAll');
  if(selAll && mainAll > 0) selAll.checked = mainSel === mainAll;
  const selAllSku = document.getElementById('selAllSku');
  if(selAllSku && skuAll > 0) selAllSku.checked = skuSel === skuAll;
}

// 通用下载一组图片（抽取 downloadAllImages 逻辑）
async function downloadImageList(urls, btn){
  if(!urls.length){ toast('没有可下载的图片'); return; }
  btn.disabled = true;
  const origText = btn.innerHTML;

  if(window.showDirectoryPicker){
    try{
      const dirHandle = await window.showDirectoryPicker();
      let success = 0;
      for(let i = 0; i < urls.length; i++){
        btn.innerHTML = '<span class="spinner"></span> 保存中 ' + (i+1) + '/' + urls.length;
        try{
          const src = urls[i];
          const dlUrl = '/api/proxy_image?url=' + encodeURIComponent(src);
          const resp = await fetch(dlUrl);
          if(!resp.ok) continue;
          const blob = await resp.blob();
          const ext = (src.match(/\.(jpg|jpeg|png|webp)/i) || ['jpg'])[1];
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
      if(e.name === 'AbortError'){ btn.disabled=false; btn.innerHTML=origText; return; }
    }
  }

  let success = 0;
  for(let i = 0; i < urls.length; i++){
    btn.innerHTML = '<span class="spinner"></span> 下载中 ' + (i+1) + '/' + urls.length;
    try{
      const src = urls[i];
      const dlUrl = '/api/proxy_image?url=' + encodeURIComponent(src);
      const resp = await fetch(dlUrl);
      if(!resp.ok) continue;
      const blob = await resp.blob();
      const ext = (src.match(/\.(jpg|jpeg|png|webp)/i) || ['jpg'])[1];
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

async function downloadSelectedImages(){
  const urls = getSelectedImages();
  await downloadImageList(urls, document.getElementById('dlSelBtn'));
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
