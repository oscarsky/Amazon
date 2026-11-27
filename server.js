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

// 复用亚马逊会话 cookie（session-id 等）。裸语言 cookie 没有会话容易被判异常。
let amazonSession = { ck: '', at: 0 };
async function getAmazonSession() {
  if (amazonSession.ck && Date.now() - amazonSession.at < 5 * 60 * 1000) return amazonSession.ck;
  try {
    // /gp/cart/view.html 是轻量端点，会下发 session-id / i18n-prefs / lc-main
    const r = await axios.get('https://www.amazon.com/gp/cart/view.html', {
      headers: buildHeaders(),
      timeout: 6000,
      decompress: true,
    });
    const ck = (r.headers['set-cookie'] || [])
      .map(c => c.split(';')[0])
      .filter(p => !/^(lc-main|i18n-prefs)=/i.test(p))
      .join('; ');
    if (ck) amazonSession = { ck, at: Date.now() };
    return ck;
  } catch (e) {
    return '';
  }
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
  let fallbackBody = null; // 非中文但有效的商品页（最后兜底，交给上层翻译）
  // 语言/币种 cookie：不携带会拿到英文 UI + 美元价
  const LOCALE_COOKIE = 'lc-main=zh_CN; i18n-prefs=CNY';
  // 平台网关 30s 超时：抓取阶段最多用 16s，剩余留给变体图与翻译
  const fetchDeadline = Date.now() + 16000;
  let sessionCk = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0 && Date.now() > fetchDeadline) break;
    try {
      const headers = buildHeaders();
      headers['Referer'] = 'https://www.amazon.com/-/zh/';
      if (attempt === 0) {
        // 会话 cookie + 语言 cookie（实测最稳：不带 session-id 的裸 cookie 容易被判异常）
        if (sessionCk === null) sessionCk = await getAmazonSession();
        headers['Cookie'] = sessionCk ? LOCALE_COOKIE + '; ' + sessionCk : LOCALE_COOKIE;
      } else if (attempt === 1) {
        headers['Cookie'] = LOCALE_COOKIE;
      } // attempt 2: 不带 cookie

      const r = await axios.get(cleanUrl, {
        headers,
        maxRedirects: 5,
        timeout: 6000,
        decompress: true,
      });
      const body = typeof r.data === 'string' ? r.data : '';

      const isCaptcha = !body || body.includes('validateCaptcha') || body.includes('Type the characters');
      const isProduct = /id="productTitle"/.test(body);
      const isZh = /[\u4e00-\u9fa5]{2,}/.test(body);

      if (r.status === 200 && !isCaptcha && isProduct) {
        if (isZh) return body;          // 中文页：直接用
        fallbackBody = body;            // 英文页：记下来，交给上层翻译
      }
      lastErr = r.status === 200 ? (isCaptcha ? 'captcha' : 'non-product') : `status=${r.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
  }
  if (fallbackBody) return fallbackBody;
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
  // 优先从商品详情表（productDetails_db_sections / detailBullets）里取"品牌"字段
  // 注意：表格里的"品牌"就是真正的商品品牌（Boka、Pure Protein），而 byline 是店铺名（旗舰店）
  const brandKeywords = [
    '品牌', '品牌名称', '品牌名稱',   // 中文
    'Brand', 'Brand Name',           // 英文
  ];
  let brand = parseDetailRow($, brandKeywords);
  if (brand) return brand;
  // 兜底：byline / 品牌旗舰店链接（从"访问 X 品牌旗舰店"里提取 X）
  const a = $('a#bylineInfo, a[href*="/stores/"]').first();
  if (a.length) {
    const txt = a.text().trim();
    // 匹配各种形态：造訪 X 品牌旗舰店 / 访问 X 品牌旗舰店 / Visit the X Store / X Storefront
    const m1 = txt.match(/(?:造訪|访问|Visit)\s*(?:the\s*)?([^\s品牌旗]{1,50})\s*(?:品牌)?旗舰店?/i);
    if (m1) return cleanText(m1[1]);
    const m2 = txt.match(/(?:Visit|访问)\s*(?:the\s*)?([^\s]+?)\s*(?:Store|旗舰店)/i);
    if (m2) return cleanText(m2[1]);
    // href 里 /stores/BrandName/... 提取品牌名
    const href = a.attr('href') || '';
    const hm = href.match(/\/stores\/([^/?]+)/i);
    if (hm) return cleanText(hm[1].replace(/-/g, ' '));
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
  // 0. data-initiallySelected="true" 的 swatch li —— Amazon 新版结构
  const initSel = $('li[data-initiallyselected="true"], li[data-initiallySelected="true"]').toArray();
  for (const el of initSel) {
    const txt = cleanText($(el).find('.swatch-title-text-display, .a-button-text').first().text());
    if (txt && txt.length > 0 && txt.length < 80) return txt;
  }
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
 * 从页面 HTML 中解析 colorImages，返回变体名称 -> 图片条目数组 的映射
 * Amazon 近期结构：colorImages = { 'initial': A.$.parseJSON('[...]'), [otherKey]: A.$.parseJSON('[...]'), ... }
 * 每个变体可能有多张图，每个条目带 hiRes / large / physicalIdForMedia / variant(PTxx) 等字段
 */
function parseColorImages(html) {
  const result = {};
  // 1) 先找到 colorImages 的外层 { ... } 边界（用平衡大括号 + 字符串感知）
  const startIdx = html.search(/['"]colorImages['"]\s*:\s*\{/);
  if (startIdx < 0) return result;
  let i = html.indexOf('{', startIdx);
  if (i < 0) return result;
  let depth = 0, inStr = null, esc = false, close = -1;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
    } else {
      if (c === '"' || c === "'") inStr = c;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { close = i; break; } }
    }
  }
  if (close < 0) return result;
  const objSrc = html.slice(startIdx, close + 1);
  // 2) 遍历每个 key -> A.$.parseJSON('...') 调用，用单引号内部不含转义作为边界
  const re = /(['"])([^'"]+)\1\s*:\s*A\.\$\.parseJSON\('([^']*?)'\)/g;
  let m;
  while ((m = re.exec(objSrc)) !== null) {
    const key = m[2].trim();
    let arr;
    try { arr = JSON.parse(m[3]); } catch (e) { continue; }
    if (Array.isArray(arr)) result[key] = arr;
  }
  return result;
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
 * 把英文文本翻译成中文（用于亚马逊未提供中文翻译的商品）
 * 主用 MyMemory 免费接口，Google 兜底；失败则原样返回
 */
async function translateChunk(chunk) {
  try {
    const r = await axios.get('https://api.mymemory.translated.net/get', {
      params: { q: chunk, langpair: 'en|zh-CN' },
      timeout: 6000,
    });
    const t = r.data && r.data.responseData && r.data.responseData.translatedText;
    if (t && !/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(t)) return t;
  } catch (e) { /* ignore */ }
  return null;
}

async function translateToZh(text) {
  if (!text) return text;
  const s = String(text);
  if (/[\u4e00-\u9fa5]/.test(s)) return text;

  // MyMemory 单次约 500 字符上限，按句子/空格切块
  const parts = [];
  let rest = s;
  while (rest.length > 450) {
    let cut = rest.lastIndexOf('. ', 450);
    if (cut < 200) cut = rest.lastIndexOf(' ', 450);
    if (cut < 1) cut = 450;
    parts.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) parts.push(rest);

  try {
    const out = [];
    for (const p of parts) {
      const t = await translateChunk(p);
      if (!t) throw new Error('chunk failed');
      out.push(t);
    }
    const joined = out.join('').trim();
    if (/[\u4e00-\u9fa5]/.test(joined)) return joined;
  } catch (e) { /* fall through to google */ }

  try {
    const r = await axios.get('https://translate.googleapis.com/translate_a/single', {
      params: { client: 'gtx', sl: 'auto', tl: 'zh-CN', dt: 't', q: s.slice(0, 4500) },
      timeout: 5000,
    });
    if (Array.isArray(r.data) && Array.isArray(r.data[0])) {
      const o = r.data[0].map(x => (x && x[0]) || '').join('');
      if (/[\u4e00-\u9fa5]/.test(o)) return o;
    }
  } catch (e) { /* ignore */ }
  return text;
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

  // 方法2: 通过"總計/总计/Total"等标签所在行找价格
  // 价格可能是 .a-offscreen（主价格），也可能是 tr 里同 row 下的任何 CNY/¥/$ 文本（如总计行）
  $('.a-color-secondary').each((_, el) => {
    const label = cleanText($(el).text());
    let key = null;
    if (/總計|总计|^Total$/i.test(label)) key = 'total';
    else if (/^價格$|^价格$|^Price$/i.test(label)) key = 'unit';
    else if (/配送|^Shipping/i.test(label)) key = 'shipping';
    else if (/進口費用|进口费用|進口費|进口费|^Import/i.test(label)) key = 'importFee';

    if (key) {
      const $row = $(el).closest('.a-row, tr');
      if (!$row.length) return;
      // 优先 .a-offscreen（主价格标签里的）
      let priceEl = $row.find('.a-offscreen').first();
      // 兜底：找同 row 里任何包含 "CNY" / "¥" / "$" 的 span
      if (!priceEl.length) {
        priceEl = $row.find('span').filter((_, s) => /(?:CNY|¥|\$)\s*[\d.,]+/.test(cleanText($(s).text()))).first();
      }
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
 * 把视频 m3u8 用 ffmpeg 异步转成 mp4，存到 TMP 目录
 * 转为 mp4 后返回本地路径（失败则返回 null）
 */
function convertVideoToMp4(m3u8Url) {
  return new Promise((resolve) => {
    if (!m3u8Url) return resolve(null);
    const outName = `amz_vid_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`;
    const outPath = path.join(TMP_DIR, outName);
    const ffmpegPath = require('ffmpeg-static');
    const args = [
      '-y', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,httpproxy',
      '-i', m3u8Url,
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
      outPath,
    ];
    const proc = spawn(ffmpegPath, args, { stdio: 'ignore' });
    const timer = setTimeout(() => { try { proc.kill(); } catch(e){} resolve(null); }, 120000);
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
        resolve(outPath);
      } else {
        try { fs.unlinkSync(outPath); } catch(e){}
        resolve(null);
      }
    });
  });
}

/**
 * 解析亚马逊 twister 变体数据（sortedDimValuesForAllDims）
 * 每个尺寸值都带 defaultAsin，可用该 ASIN 商品页主图作为该尺寸的真实图片
 */
function parseTwisterDims(html) {
  const re = /data-a-state="\{&quot;key&quot;:&quot;desktop-twister-sort-filter-data&quot;\}"[^>]*>([\s\S]*?)<\/script>/;
  const m = html.match(re);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1].trim());
    const all = obj && obj.sortedDimValuesForAllDims;
    if (all && typeof all === 'object') return all;
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * 从多个变体维度中挑出需要展示的维度（尺寸类 + 风味类）
 * 顺序：尺寸 → 风味 → 其他（排除颜色/图案/样式等）
 */
function pickVariantDimKeys(dims) {
  const keys = Object.keys(dims).filter(k => Array.isArray(dims[k]) && dims[k].length);
  const SIZE = /size|capacity|weight|volume|count|quantity|number/i;
  const FLAVOR = /flavor|flavour|scent|taste|口味|风味/i;
  const BAD = /color|colour|pattern|style|configuration/i;
  const out = [];
  const push = (k) => { if (k && !out.includes(k)) out.push(k); };
  push(keys.find(k => SIZE.test(k) && !BAD.test(k)));
  push(keys.find(k => FLAVOR.test(k) && !BAD.test(k)));
  if (!out.length) push(keys.find(k => !BAD.test(k)));
  return out;
}

// 变体 ASIN -> 主图 URL 缓存（避免重复请求同一变体页）
const variantImgCache = new Map();

async function fetchVariantMainImage(asin) {
  if (variantImgCache.has(asin)) return variantImgCache.get(asin);
  let result = null;
  try {
    const headers = buildHeaders();
    headers['Referer'] = 'https://www.amazon.com/';
    const ck = await getAmazonSession();
    headers['Cookie'] = ck ? 'lc-main=zh_CN; i18n-prefs=CNY; ' + ck : 'lc-main=zh_CN; i18n-prefs=CNY';
    const r = await axios.get('https://www.amazon.com/dp/' + asin, {
      headers, timeout: 6000, maxRedirects: 5, decompress: true,
    });
    const data = typeof r.data === 'string' ? r.data : '';
    if (data && !data.includes('validateCaptcha')) {
      const m = data.match(/"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
      if (m) result = m[1];
    }
  } catch (e) { /* ignore */ }
  if (variantImgCache.size > 300) variantImgCache.clear();
  variantImgCache.set(asin, result);
  return result;
}

/**
 * 并行获取多个变体 ASIN 的主图（最多 4 并发，整体 8s 上限）
 */
async function fetchVariantMainImages(asins, capMs) {
  const uniq = [...new Set(asins.filter(Boolean))];
  const out = {};
  let cursor = 0;
  async function worker() {
    while (cursor < uniq.length) {
      const idx = cursor++;
      const asin = uniq[idx];
      out[asin] = await fetchVariantMainImage(asin);
    }
  }
  const cap = Math.max(1500, Number(capMs) || 7000);
  const job = Promise.all(Array.from({ length: Math.min(6, uniq.length) }, worker));
  await Promise.race([job, new Promise(r => setTimeout(r, cap))]);
  return out;
}

/**
 * 主采集流程
 */
async function scrape(productUrl) {
  const DEADLINE = Date.now() + 22000; // 平台网关 30s，留 8s 余量
  const html = await fetchAmazon(productUrl);
  const $ = cheerio.load(html);

  const titleEl = $('#productTitle');
  let title = cleanText(t2s(titleEl.text().trim()));

  const priceDetail = parsePriceDetail($);

  let bullets = [];
  $('#feature-bullets li span').each((_, el) => {
    const txt = cleanText(t2s($(el).text().trim()));
    if (txt && !txt.startsWith('查看')) bullets.push(txt);
  });

  const video = parseVideo(html);
  const brand = parseBrand($);
  const dimensions = parseDimensions($);

  // 并行启动视频转换（fire-and-forget，不阻塞主采集）
  let videoPromise = null;
  if (video && video.stream720) {
    videoPromise = convertVideoToMp4(video.stream720);
  }

  // 从 colorImages 中获取变体名称 -> 高清图片数组 的映射（名称为英文原文）
  const colorImages = parseColorImages(html);

  // 主图画廊 = colorImages.initial 里每个 variant 的 hiRes（按数组顺序）
  // Efferdent: MAIN + PT02 + PT03 + PT04 + PT05 + PT06 + PT08 = 7 张
  // B00513SMME: MAIN + PT01 + ... = 8 张
  // 注意：不再排除 PTxx！Amazon 前端画廊就是按 variant 顺序展示
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
  // 1) colorImages.initial 里每个 variant 的 hiRes 是最权威来源
  const initial = colorImages.initial || [];
  for (const it of initial) {
    if (!it) continue;
    const hr = it.hiRes || it.large;
    if (hr) addImg(hr);
  }
  // 2) 如果有 colorImages 的二级 key（老形态，key 就是变体名），它们的 hiRes 也加进来
  //    避免某些商品画廊既在 initial 也在二级 key 里
  for (const [k, arr] of Object.entries(colorImages)) {
    if (k === 'initial' || k === 'videos') continue;
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      if (!it) continue;
      const hr = it.hiRes || it.large;
      if (hr) addImg(hr);
    }
  }
  // 兜底：CAPTCHA 导致 initial 为空时，用 parseAllHiResImages
  if (galleryImgs.length === 0) {
    for (const u of parseAllHiResImages(html)) addImg(u);
  }

  const images = galleryImgs;
  const fallbackImg = (images && images[0]) ? images[0] : '';

  // 其他尺寸（SKU）
  let variants = [];

  // 1) 优先：亚马逊 twister 数据（sortedDimValuesForAllDims）——取「尺寸类 + 风味类」维度，
  //    每个值都带 defaultAsin，其真实图片 = 对应 ASIN 商品页主图
  const twisterDims = parseTwisterDims(html);
  const dimKeys = twisterDims ? pickVariantDimKeys(twisterDims) : [];
  const currentAsin = ((productUrl.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1] || '').toUpperCase();
  if (dimKeys.length) {
    const seenNames = new Set();
    const list = [];
    for (const k of dimKeys) {
      for (const v of (twisterDims[k] || [])) {
        if (!v || !v.dimensionValueDisplayText) continue;
        if (v.dimensionValueState === 'UNAVAILABLE') continue;
        const name = cleanText(v.dimensionValueDisplayText);
        if (!name || seenNames.has(name)) continue;
        seenNames.add(name);
        list.push({ name, asin: (v.defaultAsin || '').toUpperCase() });
      }
    }
    if (list.length) {
      const needFetch = list.map(v => v.asin).filter(a => a && a !== currentAsin);
      // 预留 6s 给后续处理，避免超过平台 30s 网关
      const capForVariants = Math.max(1500, Math.min(7000, DEADLINE - Date.now() - 6000));
      const imgMap = needFetch.length ? await fetchVariantMainImages(needFetch, capForVariants) : {};
      for (const v of list) {
        const img = v.asin === currentAsin ? fallbackImg : (imgMap[v.asin] || fallbackImg);
        variants.push({ name: v.name, image: img });
      }
    }
  }

  const ciKeys = Object.keys(colorImages).filter(k => k !== 'initial' && k !== 'videos');
  if (variants.length === 0) {
  if (ciKeys.length > 0) {
    // 老形态：colorImages 有二级 key（key 即变体名）
    for (const k of ciKeys) {
      const arr = colorImages[k];
      variants.push({ name: k, image: arr && arr[0] && (arr[0].hiRes || arr[0].large) || fallbackImg });
    }
  } else {
    // 新形态：colorImages 只有 initial（variants 藏在 initial 的 variant 字段里，如 PT02 / PT03 ...）
    // initial 数组里 MAIN 之后的 PTxx 条目 与 swatch DOM 的 idx 按顺序对齐
    const initial = colorImages.initial || [];
    const pt2img = {}; // PTxx -> hiRes URL
    const variantOrder = []; // MAIN 之后的 PTxx 按出现顺序
    for (const it of initial) {
      const v = it && it.variant;
      if (v && v !== 'MAIN') {
        if (it.hiRes) pt2img[v] = it.hiRes;
        variantOrder.push(v);
      }
    }
    // 扫描 swatchAvailable 变体名，按 idx 顺序对应 variantOrder 的 PTxx
    // 为什么能对齐：Amazon 前端生成 initial 数组时 MAIN 在前，然后 PT02/PT03/... 跟 swatch DOM 的 idx 顺序一致
    const rawHTML = $.html();
    // 也建个 thumbnailIndex -> PT 映射（从 data-thumb-action JSON，更精准的兜底）
    const idx2PT = {};
    const re = /data-thumb-action="(\{[^"]+\})"/g;
    let rm;
    while ((rm = re.exec(rawHTML)) !== null) {
      try {
        const obj = JSON.parse(rm[1].replace(/&quot;/g, '"'));
        if (obj.variant && typeof obj.thumbnailIndex === 'number') idx2PT[obj.thumbnailIndex] = obj.variant;
      } catch (e) {}
    }
    // 扫描 swatch DOM 拿可读变体名 + 所属分组标签
    // 多分组商品（尺寸+口味）时只保留"尺寸/count/盎司"这类分组，跳过 flavor/color 等
    const SIZE_KEYWORDS = /尺寸|规格|重量|容量|数量|净含量|count|pack|size|weight|volume|quantity|盎司|fl.?oz|\boz\b|ml\b|litre|liter|kg|g\b|lb\b|片|粒|瓶|罐|盒|包/;
    const EXCLUDE_KEYWORDS = /口味|味道|风味|香味|香气|类型|款式|颜色|色|flavor|taste|scent|color|style|type/;
    // 粗略的"这不是分组名而是变体名"判定（避免把 "4盎司" 这种变体名误当分组名）
    const swatchNameRegex = /[0-9]|count|pack|pack of|盎司|fl.?oz|\boz\b|口味|flavor|颜色|color/;

    function detectGroupLabel($li) {
      // 往上找：label 标签 / 带分组文字的 .a-button-text / .twister-popper-trigger
      let p = $li.parent();
      let depth = 0;
      while (p.length && depth < 8) {
        // 1) 父容器的直接 label 子元素
        const directLbl = p.find('> label').first();
        if (directLbl.length) {
          const t = cleanText(directLbl.text()).replace(/[:：]/g,'').trim();
          if (t && t.length < 60) return t;
        }
        // 2) 父容器的 .a-button-text 子元素（常是分组名）
        const btnLbl = p.find('> .a-button-text').first();
        if (btnLbl.length && btnLbl.text().trim().length < 80) {
          const t = cleanText(btnLbl.text()).replace(/[:：]/g,'').trim();
          if (t && t.length < 60 && !swatchNameRegex.test(t)) return t;
        }
        // 3) 前一个兄弟节点里是否有 label / 分组文字
        const prevSib = p.prev();
        if (prevSib.length) {
          const lbl = prevSib.find('label, .a-button-text').first();
          if (lbl.length) {
            const t = cleanText(lbl.text()).replace(/[:：]/g,'').trim();
            if (t && t.length < 60 && !swatchNameRegex.test(t)) return t;
          }
        }
        p = p.parent();
        depth++;
      }
      return '';
    }

    const swatchListRaw = [];
    $('li[data-csa-c-content-id*="swatch"]').each((_, el) => {
      const $li = $(el);
      const cid = ($li.attr('data-csa-c-content-id') || '').toLowerCase();
      const isAvailable = cid.includes('swatchavailable') && !cid.includes('currentlyunavailable');
      if (!isAvailable) return;
      const txt = cleanText($li.find('.swatch-title-text-display, .a-button-text').first().text());
      if (!txt) return;
      const idxStr = $li.attr('data-idxintoggleswatchlist');
      const idx = idxStr != null ? parseInt(idxStr, 10) : null;
      const groupLabel = detectGroupLabel($li);
      swatchListRaw.push({ name: txt, idx, groupLabel });
    });

    // 分组决策：多分组时优先保留"类尺寸"分组，单分组或无标签时全保留
    const groupLabels = [...new Set(swatchListRaw.map(s => s.groupLabel).filter(Boolean))];
    let filtered = swatchListRaw;
    if (groupLabels.length >= 2) {
      // 找出所有"类尺寸"分组
      const sizeGroups = groupLabels.filter(g => SIZE_KEYWORDS.test(g) && !EXCLUDE_KEYWORDS.test(g));
      if (sizeGroups.length > 0) {
        filtered = swatchListRaw.filter(s => !s.groupLabel || sizeGroups.includes(s.groupLabel));
      }
    }
    // 二次兜底：按变体名关键词再筛一次（名称含 EXCLUDE 关键词的单独踢掉）
    filtered = filtered.filter(s => !EXCLUDE_KEYWORDS.test(s.name) || SIZE_KEYWORDS.test(s.name));

    const swatchList = filtered;
    // 匹配 hiRes：优先 idx2PT[swatch.idx+1]（thumbnailIndex 比 swatch idx 多 1 因为 MAIN 占位 thumb idx=0）
    // 其次 initial 数组里 MAIN 之后的 PT 位置 = swatch idx
    for (const s of swatchList) {
      let hiRes = null;
      if (s.idx != null) {
        // 1) thumbnailIndex = swatch idx + 1 (MAIN 占位 thumb idx=0)
        const tIdx = s.idx + 1;
        if (idx2PT[tIdx] && pt2img[idx2PT[tIdx]]) {
          hiRes = pt2img[idx2PT[tIdx]];
        }
        // 2) 兜底：直接 variantOrder[swatch.idx]
        if (!hiRes && variantOrder[s.idx] && pt2img[variantOrder[s.idx]]) {
          hiRes = pt2img[variantOrder[s.idx]];
        }
      }
      variants.push({ name: s.name, image: hiRes || fallbackImg });
    }
    // 最后兜底：swatch DOM 也没找到时用 parseVariants
    if (variants.length === 0) {
      variants = parseVariants($);
      variants.forEach(v => { if (!v.image) v.image = fallbackImg; });
    }
  }
  }

  // 等待视频预转换完成（已经在后台并行跑了，几乎无额外延迟）
  let videoResult = video;
  if (videoPromise) {
    try {
      const mp4Path = await videoPromise;
      if (mp4Path && videoResult) {
        // 用文件大小做简短缓存 TTL 7 天（简单 hash），让前端点击时还能直接下载
        videoResult = { ...videoResult, mp4Ready: true, mp4Path: path.basename(mp4Path) };
      } else if (videoResult) {
        videoResult = { ...videoResult, mp4Ready: false };
      }
    } catch (e) {
      if (videoResult) videoResult = { ...videoResult, mp4Ready: false };
    }
  }

  // 亚马逊未提供中文翻译（返回英文页）时，自行翻译标题与五点描述
  let translated = false;
  if (title && !/[\u4e00-\u9fa5]/.test(title)) {
    try {
      const job = (async () => {
        const zhTitle = await translateToZh(title);
        const zhBullets = await Promise.all(bullets.map(b => translateToZh(b)));
        return { zhTitle, zhBullets };
      })();
      const res = await Promise.race([job, new Promise(r => setTimeout(() => r(null), Math.max(1500, Math.min(4000, DEADLINE - Date.now() - 1500))))]);
      if (res && res.zhTitle && /[\u4e00-\u9fa5]/.test(res.zhTitle)) {
        title = res.zhTitle;
        bullets = res.zhBullets;
        translated = true;
      }
    } catch (e) { /* ignore */ }
  }

  return { title, price: priceDetail.total, priceDetail, bullets, images, video: videoResult, brand, dimensions, variants, url: productUrl, _debug: { galleryInCount: initial.length, galleryFinal: galleryImgs.length, variantCount: variants.length, translated } };
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

  // 收集已用文件名，避免重名覆盖
  const usedNames = new Set();
  for (const imgUrl of images) {
    try {
      const r = await axios.get(imgUrl, {
        headers: buildHeaders(),
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      // 用 URL 里的默认文件名，同文件多份时自动加 _1 / _2 后缀
      let name = path.basename(new URL(imgUrl).pathname);
      if (!name || !/\.(jpg|jpeg|png|webp|gif)$/i.test(name)) {
        name = `image.${(imgUrl.match(/\.(jpg|jpeg|png|webp)/i) || ['.jpg'])[1].replace(/^\./, '')}`;
      }
      // 去重：同名已用则加后缀
      if (usedNames.has(name)) {
        const m = name.match(/^(.+?)(\.[^.]+)$/);
        if (m) {
          let n = 1;
          let cand = `${m[1]}_${n}${m[2]}`;
          while (usedNames.has(cand)) cand = `${m[1]}_${++n}${m[2]}`;
          name = cand;
        }
      }
      usedNames.add(name);
      archive.append(Buffer.from(r.data), { name });
    } catch (e) {
      // 跳过失败的图片
    }
  }
  await archive.finalize();
});

// 预转换 mp4 下载接口 — scrape 时已转好，前端点下载直接走这里
app.get('/api/video_download', (req, res) => {
  const file = (req.query.file || '').trim();
  if (!file || !file.startsWith('amz_vid_') || !file.endsWith('.mp4')) {
    return res.status(400).json({ error: '无效的视频文件' });
  }
  const fullPath = path.join(TMP_DIR, file);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: '视频文件不存在（可能已过期，请重新采集）' });
  }
  res.download(fullPath, 'amazon_product_video.mp4', (err) => {
    if (err) { /* download 出错就不管了 */ }
    // 24 小时后清理 —— 用 setTimeout 延迟清理，避免下载刚发出去就删了
    setTimeout(() => {
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
    }, 24 * 3600 * 1000);
  });
});

// 视频 m3u8 -> mp4（后备接口，当预转换失败时使用）
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
  /* 其他尺寸：图片与文字分开，图片可勾选（与主图一起下载） */
  .sku-grid { display: flex; flex-wrap: wrap; gap: 16px; }
  .sku-grid.placeholder { color: #bbb; font-style: italic; display: flex; align-items: center; justify-content: center; min-height: 40px; }
  .sku-item { width: 140px; display: flex; flex-direction: column; gap: 8px; }
  .sku-img-wrap { position: relative; }
  .sku-img { display: block; border-radius: 8px; overflow: hidden; background: #f7f7f7; aspect-ratio: 1; }
  .sku-img img { width: 100%; height: 100%; object-fit: contain; }
  .sku-img .dl-overlay { position: absolute; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .15s; border-radius: 8px; color: #fff; font-size: 13px; }
  .sku-img:hover .dl-overlay { opacity: 1; }
  .sku-noimg { display: flex; align-items: center; justify-content: center; background: #f0f0f0; color: #999; font-size: 12px; border-radius: 8px; aspect-ratio: 1; }
  .sku-name { font-size: 13px; color: #333; line-height: 1.4; text-align: center; word-break: break-word; cursor: pointer; }
  .sku-name:hover { color: #ff9900; text-decoration: underline; }
  .sku-copied { font-size: 10px; background: #4CAF50; color: #fff; padding: 1px 5px; border-radius: 3px; margin-left: 4px; }
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

  <!-- 尺寸选择（亚马逊风格方框，hover/点击切换主图） -->
  <div class="card">
    <div class="media-header">
      <div class="field-label">其他尺寸 <label style="margin-left:12px;font-weight:normal;color:#aaa;font-size:12px;cursor:pointer"><input type="checkbox" id="selAllSku" checked onchange="toggleSelAllSku(this.checked)" style="margin-right:4px">全选 / 全不选</label></div>
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
    if(d.video.mp4Ready && d.video.mp4Path){
      // 预转换成功 — 直接用后端已转好的 mp4 下载接口
      vidEl.innerHTML = '<div class="video-thumb"><video src="'+d.video.master+'" muted playsinline preload="metadata"></video></div><div class="video-info"><div class="vtitle">主图视频</div><div class="vmeta">已为你转好 MP4，点击下方按钮直接保存</div></div><a class="btn btn-primary" href="/api/video_download?file='+encodeURIComponent(d.video.mp4Path)+'" download="amazon_product_video.mp4">⬇ 下载视频 (MP4)</a>';
    } else {
      // 预转换失败 — 走后备接口（用户点击时现转）
      vidEl.innerHTML = '<div class="video-thumb"><video src="'+d.video.master+'" muted playsinline preload="metadata"></video></div><div class="video-info"><div class="vtitle">主图视频</div><div class="vmeta">正在转码，请稍候...</div></div><button class="btn btn-primary" onclick="downloadVideo(\\''+d.video.stream720+'\\', this)">⬇ 下载视频</button>';
    }
  } else {
    vidEl.textContent = '暂无视频';
    vidEl.classList.add('placeholder');
  }

  // 其他尺寸：图片（可勾选 + 可单独下载）与文字（可复制）分开显示
  const skuEl = document.getElementById('fSkuImages');
  window._skuVariants = d.variants || [];
  if(d.variants && d.variants.length){
    skuEl.classList.remove('placeholder');
    let html = '';
    d.variants.forEach((v,i)=>{
      const safeName = escapeHtml(v.name);
      const copyText = String(v.name).replace(/"/g,'&quot;');
      html += '<div class="sku-item" data-idx="'+i+'">';
      html += '<div class="sku-img-wrap">';
      if (v.image) {
        const src = escapeHtml(v.image);
        const dl = '/api/proxy_image?url=' + encodeURIComponent(v.image);
        html += '<a class="sku-img" href="'+dl+'" download title="点击下载此图"><img src="'+src+'" alt="'+safeName+'" loading="lazy" onerror="this.remove()"><div class="dl-overlay"><span>⬇ 下载</span></div></a>';
        html += '<input type="checkbox" class="sku-img-sel" data-src="'+src+'" checked onchange="updateSelBtn()" style="position:absolute;top:6px;left:6px;z-index:10;width:16px;height:16px;cursor:pointer">';
      } else {
        html += '<div class="sku-noimg">无图片</div>';
      }
      html += '</div>';
      html += '<div class="sku-name" data-copy="'+copyText+'" title="点击复制">'+safeName+'</div>';
      html += '</div>';
    });
    skuEl.innerHTML = html;

    // 文字点击复制
    skuEl.addEventListener('click', async function(e){
      const nameEl = e.target.closest('.sku-name');
      if(!nameEl) return;
      e.stopPropagation();
      const text = nameEl.dataset.copy || nameEl.textContent;
      try { await navigator.clipboard.writeText(text); } catch(err) {
        try {
          const ta = document.createElement('textarea');
          ta.value = text; ta.style.position='fixed'; ta.style.opacity=0;
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
        } catch(e2) {}
      }
      // 短暂的"已复制"视觉反馈
      let tip = nameEl.querySelector('.sku-copied');
      if (!tip) {
        tip = document.createElement('span');
        tip.className = 'sku-copied';
        nameEl.appendChild(tip);
      }
      tip.textContent = '已复制';
      tip.style.display = '';
      clearTimeout(window._skuCopiedTimer);
      window._skuCopiedTimer = setTimeout(()=>{ tip.style.display='none'; }, 1200);
      toast('已复制：' + text);
    });
    updateSelBtn();
  } else {
    skuEl.textContent = '该商品无其他尺寸';
    skuEl.classList.add('placeholder');
  }
}

// 一键下载全部图片（主图 + 所有其他尺寸图，去重）
async function downloadAllImages(){
  const skuUrls = [];
  document.querySelectorAll('.sku-img-sel').forEach(c => { if(c.dataset.src) skuUrls.push(c.dataset.src); });
  const seen = new Set();
  const all = [];
  for (const u of [...currentImages, ...skuUrls]) {
    const m = u.match(/\\/images\\/I\\/([A-Za-z0-9+\\-]+)\\._/);
    const id = m ? m[1] : u;
    if (!seen.has(id)) { seen.add(id); all.push(u); }
  }
  await downloadImageList(all, document.getElementById('dlAllBtn'));
}

// ============ 勾选下载（主图 + 其他尺寸图） ============
function getSelectedMainImages(){
  const checks = document.querySelectorAll('.img-sel');
  const urls = [];
  checks.forEach(c => { if(c.checked){ const idx = parseInt(c.dataset.idx,10); if(!isNaN(idx) && currentImages[idx]) urls.push(currentImages[idx]); } });
  return urls;
}
function getSelectedSkuImages(){
  const urls = [];
  document.querySelectorAll('.sku-img-sel').forEach(c => { if(c.checked && c.dataset.src) urls.push(c.dataset.src); });
  return urls;
}
// 合并勾选（主图 + 其他尺寸图，按图片 ID 去重）
function getSelectedImages(){
  const seen = new Set();
  const merged = [];
  for (const u of [...getSelectedMainImages(), ...getSelectedSkuImages()]) {
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
  const btn = document.getElementById('dlSelBtn');
  if(!btn) return;
  btn.style.display = (mainAll + skuAll) > 0 ? 'inline-flex' : 'none';
  btn.textContent = '⬇ 下载选中 (' + (mainSel + skuSel) + ')';
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
      const usedNames = new Set();
      for(let i = 0; i < urls.length; i++){
        btn.innerHTML = '<span class="spinner"></span> 保存中 ' + (i+1) + '/' + urls.length;
        try{
          const src = urls[i];
          const dlUrl = '/api/proxy_image?url=' + encodeURIComponent(src);
          const resp = await fetch(dlUrl);
          if(!resp.ok) continue;
          const blob = await resp.blob();
          // 从 URL path 取默认文件名，保持原名
          let fileName = (() => { try { return decodeURIComponent(new URL(src).pathname.split('/').pop() || ''); } catch(e){ return ''; } })();
          if(!fileName) fileName = 'image.' + ((src.match(/\.(jpg|jpeg|png|webp)/i) || ['jpg'])[1]);
          // 同名去重
          if(usedNames.has(fileName)){
            const m = fileName.match(/^(.+?)(\.[^.]+)$/);
            if(m){ let n = 1; let cand = m[1] + '_' + n + m[2]; while(usedNames.has(cand)) cand = m[1] + '_' + (++n) + m[2]; fileName = cand; }
          }
          usedNames.add(fileName);
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
  const usedNames = new Set();
  for(let i = 0; i < urls.length; i++){
    btn.innerHTML = '<span class="spinner"></span> 下载中 ' + (i+1) + '/' + urls.length;
    try{
      const src = urls[i];
      const dlUrl = '/api/proxy_image?url=' + encodeURIComponent(src);
      const resp = await fetch(dlUrl);
      if(!resp.ok) continue;
      const blob = await resp.blob();
      // 从 URL path 取默认文件名，保持原名
      let fileName = (() => { try { return decodeURIComponent(new URL(src).pathname.split('/').pop() || ''); } catch(e){ return ''; } })();
      if(!fileName) fileName = 'image.' + ((src.match(/\.(jpg|jpeg|png|webp)/i) || ['jpg'])[1]);
      // 同名去重
      if(usedNames.has(fileName)){
        const m = fileName.match(/^(.+?)(\.[^.]+)$/);
        if(m){ let n = 1; let cand = m[1] + '_' + n + m[2]; while(usedNames.has(cand)) cand = m[1] + '_' + (++n) + m[2]; fileName = cand; }
      }
      usedNames.add(fileName);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
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
