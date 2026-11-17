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
  // 规范化 URL，强制 zh_TW + CNY
  const parsed = new URL(productUrl);
  parsed.searchParams.set('language', 'zh_TW');
  parsed.searchParams.set('currency', 'CNY');
  const cleanUrl = parsed.toString();

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const instance = axios.create({
        headers: HEADERS,
        maxRedirects: 5,
        timeout: 40000,
        decompress: true,
      });
      // 先访问主页预热
      try {
        await instance.get('https://www.amazon.com', { timeout: 20000 });
        await new Promise(r => setTimeout(r, 1000 + attempt * 500));
      } catch (e) { /* ignore warmup failure */ }
      const r = await instance.get(cleanUrl);
      if (r.status === 200 && !r.data.includes('validateCaptcha')) {
        return r.data;
      }
      lastErr = `status=${r.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise(r => setTimeout(r, 2000 + attempt * 1000));
  }
  throw new Error(`亚马逊返回了验证码页面或请求失败（${lastErr}），请稍后重试`);
}

/**
 * 解析所有主图大图
 */
function parseImages($) {
  const seen = [];
  const seenIds = new Set();
  $('#altImages img').each((_, el) => {
    const src = $(el).attr('src') || '';
    const m = src.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
    if (m) {
      const bid = m[1];
      if (!seenIds.has(bid)) {
        seenIds.add(bid);
        seen.push(`https://m.media-amazon.com/images/I/${bid}._SL1500_.jpg`);
      }
    }
  });
  const li = $('#landingImage');
  if (li.length) {
    const oh = li.attr('data-old-hires');
    if (oh) {
      const m = oh.match(/\/images\/I\/([A-Za-z0-9+\-]+)\._/);
      const bid = m ? m[1] : oh;
      if (!seenIds.has(bid)) {
        seenIds.add(bid);
        seen.unshift(oh);
      }
    }
  }
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
  return parseDetailRow($, ['項目型號', '项目型号', 'Item model number', 'SKU', '庫存單位']);
}

/**
 * 主采集流程
 */
async function scrape(productUrl) {
  const html = await fetchAmazon(productUrl);
  const $ = cheerio.load(html);

  const titleEl = $('#productTitle');
  const title = cleanText(t2s(titleEl.text().trim()));

  const priceEl = $('.a-price .a-offscreen').first();
  const price = cleanText(priceEl.text().trim());

  const bullets = [];
  $('#feature-bullets li span').each((_, el) => {
    const txt = cleanText(t2s($(el).text().trim()));
    if (txt && !txt.startsWith('查看')) bullets.push(txt);
  });

  const images = parseImages($);
  const video = parseVideo(html);
  const brand = parseBrand($);
  const sku = parseSku($);

  return { title, price, bullets, images, video, brand, sku, url: productUrl };
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
  header { text-align: center; margin-bottom: 28px; }
  header h1 { font-size: 26px; color: #232f3e; margin-bottom: 6px; }
  header p { color: #666; font-size: 14px; }
  .search-box { display: flex; gap: 10px; margin-bottom: 24px; }
  .search-box input { flex: 1; padding: 12px 16px; border: 1px solid #d0d0d0; border-radius: 8px; font-size: 15px; outline: none; transition: border .2s; }
  .search-box input:focus { border-color: #ff9900; box-shadow: 0 0 0 3px rgba(255,153,0,.15); }
  .search-box button { padding: 12px 28px; background: #ff9900; color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background .2s; white-space: nowrap; }
  .search-box button:hover { background: #e88a00; }
  .search-box button:disabled { background: #ccc; cursor: not-allowed; }
  .card { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 18px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .field { margin-bottom: 18px; }
  .field:last-child { margin-bottom: 0; }
  .field-label { font-size: 13px; color: #888; margin-bottom: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
  .field-value { font-size: 16px; color: #222; word-break: break-word; }
  .copy-btn { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; padding: 3px 10px; font-size: 12px; background: #eef2f7; color: #444; border: none; border-radius: 5px; cursor: pointer; transition: background .15s; }
  .copy-btn:hover { background: #dfe6ef; }
  .copy-btn.copied { background: #28a745; color: #fff; }
  .bullets { padding-left: 4px; }
  .bullets li { margin-bottom: 8px; padding-left: 20px; position: relative; list-style: none; }
  .bullets li::before { content: "•"; position: absolute; left: 0; color: #ff9900; font-weight: bold; }
  .media-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .media-header .field-label { margin-bottom: 0; }
  .download-all-btn { padding: 8px 18px; background: #232f3e; color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: background .15s; display: inline-flex; align-items: center; gap: 6px; }
  .download-all-btn:hover { background: #37475a; }
  .download-all-btn:disabled { background: #ccc; cursor: not-allowed; }
  .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 14px; }
  .media-item { position: relative; border-radius: 8px; overflow: hidden; background: #f7f7f7; aspect-ratio: 1; cursor: pointer; transition: transform .15s; }
  .media-item:hover { transform: translateY(-2px); }
  .media-item img { width: 100%; height: 100%; object-fit: contain; }
  .media-item .dl-overlay { position: absolute; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .15s; }
  .media-item:hover .dl-overlay { opacity: 1; }
  .dl-overlay span { color: #fff; font-size: 13px; font-weight: 600; }
  .video-card { display: flex; align-items: center; gap: 16px; padding: 14px; background: #f7f8fa; border-radius: 8px; margin-top: 16px; }
  .video-thumb { width: 120px; height: 68px; background: #000; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 11px; flex-shrink: 0; overflow: hidden; }
  .video-thumb video { width: 100%; height: 100%; object-fit: cover; }
  .video-info { flex: 1; }
  .video-info .vtitle { font-weight: 600; margin-bottom: 4px; }
  .video-info .vmeta { font-size: 12px; color: #888; }
  .btn { padding: 8px 18px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 500; transition: all .15s; }
  .btn-primary { background: #ff9900; color: #fff; }
  .btn-primary:hover { background: #e88a00; }
  .btn-primary:disabled { background: #ccc; }
  .empty { text-align: center; padding: 60px 20px; color: #aaa; }
  .empty .icon { font-size: 48px; margin-bottom: 12px; }
  .spinner { display: inline-block; width: 18px; height: 18px; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 10px 22px; border-radius: 20px; font-size: 14px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 999; }
  .toast.show { opacity: 1; }
  .error-msg { background: #fff5f5; color: #c53030; padding: 14px 18px; border-radius: 8px; border-left: 4px solid #c53030; }
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
  <div id="result"></div>
</div>
<div class="toast" id="toast"></div>
<script>
let currentImages = [];
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800);}
async function copyText(text,btn){
  let ok=false;
  try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);ok=true;}}catch(e){}
  if(!ok){try{const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();ok=document.execCommand('copy');document.body.removeChild(ta);}catch(e){}}
  if(ok){if(btn){btn.classList.add('copied');btn.textContent='✓ 已复制';setTimeout(()=>{btn.classList.remove('copied');btn.innerHTML='📋 复制';},1500);}else toast('已复制');}
  else toast('复制失败，请手动复制');
}
function fieldHtml(label,value){
  if(!value)return '';
  const safe=String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return '<div class="field"><div class="field-label">'+label+'</div><div class="field-value">'+safe+'<button class="copy-btn" onclick=\'copyText('+JSON.stringify(String(value))+', this)\'>📋 复制</button></div></div>';
}
async function doScrape(){
  const url=document.getElementById('urlInput').value.trim();
  if(!url){toast('请输入链接');return;}
  const btn=document.getElementById('scrapeBtn');
  const result=document.getElementById('result');
  btn.disabled=true;btn.innerHTML='<span class="spinner"></span> 采集中...';result.innerHTML='';
  try{
    const resp=await fetch('/api/scrape',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    const json=await resp.json();
    if(!resp.ok||!json.ok){result.innerHTML='<div class="error-msg">❌ '+(json.error||'采集失败')+'</div>';return;}
    renderResult(json.data);
  }catch(e){result.innerHTML='<div class="error-msg">❌ 网络错误: '+e.message+'</div>';}
  finally{btn.disabled=false;btn.textContent='开始采集';}
}
function renderResult(d){
  currentImages=d.images||[];
  const result=document.getElementById('result');
  let html='';
  html+='<div class="card">';
  html+=fieldHtml('商品标题',d.title);
  if(d.brand)html+=fieldHtml('品牌名称',d.brand);
  if(d.sku)html+=fieldHtml('SKU',d.sku);
  if(d.price)html+=fieldHtml('价格',d.price);
  html+='</div>';
  if(d.bullets&&d.bullets.length){
    const allText=d.bullets.join('\\n');
    html+='<div class="card"><div class="field-label">关于此商品 <button class="copy-btn" onclick=\'copyText('+JSON.stringify(allText)+', this)\'>📋 复制全部</button></div><ul class="bullets">';
    d.bullets.forEach(b=>{html+='<li>'+b.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</li>';});
    html+='</ul></div>';
  }
  if((d.images&&d.images.length)||d.video){
    html+='<div class="card"><div class="media-header"><div class="field-label">商品主图 ('+(d.images?d.images.length:0)+' 张) / 视频</div>';
    if(d.images&&d.images.length>1)html+='<button class="download-all-btn" id="dlAllBtn" onclick="downloadAllImages()">⬇ 一键下载全部图片</button>';
    html+='</div><div class="media-grid">';
    if(d.images){d.images.forEach((src,i)=>{
      const dl='/api/proxy_image?url='+encodeURIComponent(src);
      html+='<a class="media-item" href="'+dl+'" download><img src="'+src+'" alt="主图'+(i+1)+'" loading="lazy" onerror="this.style.opacity=.3"><div class="dl-overlay"><span>⬇ 下载</span></div></a>';
    });}
    html+='</div>';
    if(d.video){
      html+='<div class="video-card"><div class="video-thumb"><video src="'+d.video.master+'" muted playsinline preload="metadata"></video></div><div class="video-info"><div class="vtitle">主图视频</div><div class="vmeta">点击下方按钮下载为 MP4 文件</div></div><button class="btn btn-primary" onclick="downloadVideo(\\''+d.video.stream720+'\\', this)">⬇ 下载视频</button></div>';
    }
    html+='</div>';
  }
  if(!html)html='<div class="empty"><div class="icon">📭</div>未采集到有效信息</div>';
  result.innerHTML=html;
}
async function downloadAllImages(){
  if(!currentImages.length){toast('没有可下载的图片');return;}
  const btn=document.getElementById('dlAllBtn');
  btn.disabled=true;btn.innerHTML='<span class="spinner"></span> 打包中...';
  try{
    const resp=await fetch('/api/download_all_images',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({images:currentImages})});
    if(!resp.ok){toast('下载失败');return;}
    const blob=await resp.blob();
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='amazon_product_images.zip';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('全部图片已下载');
  }catch(e){toast('下载失败: '+e.message);}
  finally{btn.disabled=false;btn.innerHTML='⬇ 一键下载全部图片';}
}
async function downloadVideo(m3u8,btn){
  btn.disabled=true;btn.innerHTML='<span class="spinner"></span> 转换中...';
  try{
    const resp=await fetch('/api/video',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:m3u8})});
    if(!resp.ok){const j=await resp.json().catch(()=>({}));toast(j.error||'下载失败');btn.disabled=false;btn.textContent='⬇ 下载视频';return;}
    const blob=await resp.blob();
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='amazon_product_video.mp4';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('视频下载完成');
  }catch(e){toast('下载失败: '+e.message);}
  finally{btn.disabled=false;btn.textContent='⬇ 下载视频';}
}
document.getElementById('urlInput').addEventListener('keydown',e=>{if(e.key==='Enter')doScrape();});
</script>
</body>
</html>`;
