"""
亚马逊商品信息采集工具
- 采集主图图片、主图视频
- 采集标题、SKU、价格、关于此商品、品牌名称
- 繁体自动转简体（品牌名除外）
- 文字可复制，图片/视频可下载
"""
import os
import re
import json
import time
import uuid
import subprocess
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import requests
from bs4 import BeautifulSoup
from opencc import OpenCC
from flask import Flask, request, jsonify, send_file, render_template_string

app = Flask(__name__)
app.config['JSON_AS_ASCII'] = False

CC = OpenCC('t2s')  # 繁体 -> 简体

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,'
              'image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
}

# 视频缓存目录
VIDEO_DIR = '/workspace/videos'
os.makedirs(VIDEO_DIR, exist_ok=True)


def t2s(text):
    """繁体转简体"""
    if not text:
        return text
    try:
        return CC.convert(text)
    except Exception:
        return text


def clean_text(text):
    """清理不可见控制字符（LRM/RLM等）和多余空白"""
    if not text:
        return text
    # 移除 Unicode 双向控制字符和零宽字符
    cleaned = re.sub(r'[\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b\u200c\u200d\ufeff]', '', text)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned


def fetch_amazon(url):
    """抓取亚马逊商品页面，返回HTML文本"""
    # 规范化URL，强制 zh_TW + CNY
    parsed = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(parsed.query)
    qs['language'] = ['zh_TW']
    qs['currency'] = ['CNY']
    new_query = urllib.parse.urlencode(qs, doseq=True)
    clean_url = urllib.parse.urlunparse(parsed._replace(query=new_query))

    last_err = None
    for attempt in range(3):
        s = requests.Session()
        s.headers.update(HEADERS)
        try:
            # 先访问主页预热，降低验证码概率
            s.get('https://www.amazon.com', timeout=20)
            time.sleep(1.0 + attempt * 0.5)
            r = s.get(clean_url, timeout=40)
            if r.status_code == 200 and 'validateCaptcha' not in r.text:
                return r.text
            last_err = f'status={r.status_code}'
        except Exception as e:
            last_err = str(e)
        time.sleep(2.0 + attempt * 1.0)
    raise RuntimeError(f'亚马逊返回了验证码页面或请求失败（{last_err}），请稍后重试')


def parse_images(soup):
    """提取所有主图大图URL"""
    seen = []
    seen_ids = set()
    # 缩略图 -> 大图
    for img in soup.select('#altImages img'):
        src = img.get('src') or ''
        m = re.search(r'/images/I/([A-Za-z0-9+\-]+)\._', src)
        if m:
            bid = m.group(1)
            if bid not in seen_ids:
                seen_ids.add(bid)
                seen.append(f'https://m.media-amazon.com/images/I/{bid}._SL1500_.jpg')
    # 主图
    li = soup.select_one('#landingImage')
    if li:
        oh = li.get('data-old-hires')
        if oh:
            bid_m = re.search(r'/images/I/([A-Za-z0-9+\-]+)\._', oh)
            bid = bid_m.group(1) if bid_m else oh
            if bid not in seen_ids:
                seen_ids.add(bid)
                seen.insert(0, oh)
    return seen


def parse_video(html):
    """提取主图视频m3u8 URL"""
    # 找 master m3u8，遇到 & （HTML实体）或引号时停止
    m = re.search(r'https://m\.media-amazon\.com/images/S/[^&"\']+\.m3u8', html)
    if not m:
        return None
    master = m.group(0)
    # 尝试替换为 720p 流（更快），保留原始 master 作为后备
    master_720 = master.replace('.hls.m3u8', '.hls720.m3u8')
    return {'master': master, 'stream720': master_720}


def parse_detail_row(soup, label_keywords):
    """在详情表格中按标签关键字查找值"""
    # detailBullets (li 结构)
    for li in soup.select('#detailBullets_feature_div li'):
        text = li.get_text(' ', strip=True)
        for kw in label_keywords:
            if kw in text:
                # 取冒号后内容
                parts = re.split(r'[:：]', text, maxsplit=1)
                if len(parts) == 2:
                    return clean_text(parts[1])
    # techSpec / detailBullets_sections (tr 结构)
    for tr in soup.select('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr'):
        th = tr.select_one('th')
        td = tr.select_one('td')
        if th and td:
            th_text = th.get_text(strip=True)
            for kw in label_keywords:
                if kw in th_text:
                    return clean_text(td.get_text(strip=True))
    return None


def parse_brand(soup):
    """提取品牌名称"""
    # 优先：详情表中 品牌名稱
    brand = parse_detail_row(soup, ['品牌名稱', '品牌名称'])
    if brand:
        return brand
    # bylineInfo / 品牌旗舰店链接
    for a in soup.select('a#bylineInfo, a[href*="/stores/"]'):
        txt = a.get_text(strip=True)
        m = re.search(r'(?:品牌|store|Brand)\s*(.+)|造訪\s*(.+?)\s*品牌', txt)
        if m:
            return (m.group(1) or m.group(2)).strip()
        if txt and len(txt) < 60:
            return txt
    return None


def parse_sku(soup):
    """提取SKU（项目型号/Item model number）"""
    sku = parse_detail_row(soup, ['項目型號', '项目型号', 'Item model number', 'SKU', '庫存單位'])
    return sku


def scrape(url):
    """主采集流程，返回结构化数据"""
    html = fetch_amazon(url)
    soup = BeautifulSoup(html, 'lxml')

    title_el = soup.select_one('#productTitle')
    title = clean_text(t2s(title_el.get_text(strip=True))) if title_el else ''

    price_el = soup.select_one('.a-price .a-offscreen')
    price = clean_text(price_el.get_text(strip=True)) if price_el else ''

    bullets = []
    for span in soup.select('#feature-bullets li span'):
        txt = clean_text(t2s(span.get_text(strip=True)))
        if txt and not txt.startswith('查看'):
            bullets.append(txt)

    images = parse_images(soup)
    video = parse_video(html)
    brand = parse_brand(soup)
    sku = parse_sku(soup)

    return {
        'title': title,
        'price': price,
        'bullets': bullets,
        'images': images,
        'video': video,
        'brand': brand,
        'sku': sku,
        'url': url,
    }


# ---------------- API ----------------

@app.route('/')
def index():
    return render_template_string(INDEX_HTML)


@app.route('/api/scrape', methods=['POST'])
def api_scrape():
    data = request.get_json(silent=True) or {}
    url = data.get('url', '').strip()
    if not url or 'amazon.' not in url:
        return jsonify({'error': '请输入有效的亚马逊商品链接'}), 400
    try:
        result = scrape(url)
        return jsonify({'ok': True, 'data': result})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/video', methods=['POST'])
def api_video():
    """将 m3u8 转为 mp4 并返回下载"""
    data = request.get_json(silent=True) or {}
    m3u8 = data.get('url', '').strip()
    if not m3u8 or '.m3u8' not in m3u8:
        return jsonify({'error': '无效的视频地址'}), 400

    out_name = f'{uuid.uuid4().hex}.mp4'
    out_path = os.path.join(VIDEO_DIR, out_name)
    cmd = [
        'ffmpeg', '-y',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,httpproxy',
        '-i', m3u8,
        '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
        out_path,
    ]
    try:
        subprocess.run(cmd, check=True, timeout=300,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return jsonify({'error': '视频转换超时'}), 504
    except subprocess.CalledProcessError:
        return jsonify({'error': '视频转换失败'}), 500

    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        return jsonify({'error': '视频文件为空'}), 500

    return send_file(out_path, as_attachment=True,
                     download_name='amazon_product_video.mp4',
                     mimetype='video/mp4')


@app.route('/api/proxy_image')
def proxy_image():
    """代理下载亚马逊图片（解决跨域 download 属性问题）"""
    url = request.args.get('url', '').strip()
    if not url or 'media-amazon.com' not in url:
        return jsonify({'error': '无效的图片地址'}), 400
    try:
        r = requests.get(url, headers=HEADERS, timeout=30, stream=True)
        r.raise_for_status()
        # 从URL提取文件名
        name = os.path.basename(urllib.parse.urlparse(url).path) or 'image.jpg'
        return send_file(r.raw, mimetype=r.headers.get('Content-Type', 'image/jpeg'),
                         as_attachment=True, download_name=name)
    except Exception as e:
        return jsonify({'error': f'图片下载失败: {e}'}), 500


INDEX_HTML = r"""
<!DOCTYPE html>
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
  .search-box button { padding: 12px 28px; background: #ff9900; color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background .2s; }
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
  .title-text { font-size: 20px; font-weight: 700; color: #111; }
  .price-text { font-size: 22px; font-weight: 700; color: #b12704; }
  .bullets { padding-left: 4px; }
  .bullets li { margin-bottom: 8px; padding-left: 20px; position: relative; list-style: none; }
  .bullets li::before { content: "•"; position: absolute; left: 0; color: #ff9900; font-weight: bold; }
  .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 14px; }
  .media-item { position: relative; border-radius: 8px; overflow: hidden; background: #f7f7f7; aspect-ratio: 1; cursor: pointer; transition: transform .15s; }
  .media-item:hover { transform: translateY(-2px); }
  .media-item img { width: 100%; height: 100%; object-fit: contain; }
  .media-item .badge { position: absolute; top: 6px; left: 6px; background: rgba(0,0,0,.6); color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; }
  .media-item .dl-overlay { position: absolute; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .15s; }
  .media-item:hover .dl-overlay { opacity: 1; }
  .dl-overlay span { color: #fff; font-size: 13px; font-weight: 600; }
  .video-card { display: flex; align-items: center; gap: 16px; padding: 14px; background: #f7f8fa; border-radius: 8px; }
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
    <input id="urlInput" type="text" placeholder="请输入亚马逊商品链接，例如 https://www.amazon.com/dp/xxxx" 
           value="https://www.amazon.com/dp/B0F1TFC28B">
    <button id="scrapeBtn" onclick="doScrape()">开始采集</button>
  </div>

  <div id="result"></div>
</div>

<div class="toast" id="toast"></div>

<script>
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

async function copyText(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch(e) {}
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch(e) {}
  }
  if (ok) {
    if (btn) {
      btn.classList.add('copied');
      btn.textContent = '✓ 已复制';
      setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = '📋 复制'; }, 1500);
    } else {
      toast('已复制');
    }
  } else {
    toast('复制失败，请手动复制');
  }
}

function fieldHtml(label, value, copyable = true) {
  if (!value) return '';
  const safe = String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const btn = copyable ? `<button class="copy-btn" onclick='copyText(${JSON.stringify(String(value))}, this)'>📋 复制</button>` : '';
  return `<div class="field"><div class="field-label">${label}</div><div class="field-value">${safe}${btn}</div></div>`;
}

async function doScrape() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) { toast('请输入链接'); return; }
  const btn = document.getElementById('scrapeBtn');
  const result = document.getElementById('result');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 采集中...';
  result.innerHTML = '';
  try {
    const resp = await fetch('/api/scrape', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url})
    });
    const json = await resp.json();
    if (!resp.ok || !json.ok) {
      result.innerHTML = `<div class="error-msg">❌ ${json.error || '采集失败'}</div>`;
      return;
    }
    renderResult(json.data);
  } catch(e) {
    result.innerHTML = `<div class="error-msg">❌ 网络错误: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '开始采集';
  }
}

function renderResult(d) {
  const result = document.getElementById('result');
  let html = '';

  // 基本信息
  html += '<div class="card">';
  html += fieldHtml('商品标题', d.title);
  if (d.brand) html += fieldHtml('品牌名称', d.brand);
  if (d.sku) html += fieldHtml('SKU', d.sku);
  if (d.price) html += fieldHtml('价格', d.price);
  html += '</div>';

  // 关于此商品
  if (d.bullets && d.bullets.length) {
    const allText = d.bullets.join('\n');
    html += '<div class="card">';
    html += `<div class="field-label">关于此商品 <button class="copy-btn" onclick='copyText(${JSON.stringify(allText)}, this)'>📋 复制全部</button></div>`;
    html += '<ul class="bullets">';
    d.bullets.forEach(b => {
      html += `<li>${b.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</li>`;
    });
    html += '</ul></div>';
  }

  // 媒体：图片 + 视频
  if ((d.images && d.images.length) || d.video) {
    html += '<div class="card">';
    html += `<div class="field-label">商品主图 (${d.images ? d.images.length : 0} 张) / 视频</div>`;
    html += '<div class="media-grid">';
    if (d.images) {
      d.images.forEach((src, i) => {
        const dl = `/api/proxy_image?url=${encodeURIComponent(src)}`;
        html += `<a class="media-item" href="${dl}" download>
          <img src="${src}" alt="主图${i+1}" loading="lazy" onerror="this.style.opacity=.3">
          <div class="dl-overlay"><span>⬇ 下载</span></div>
        </a>`;
      });
    }
    html += '</div>';

    if (d.video) {
      html += `<div class="video-card" style="margin-top:16px">
        <div class="video-thumb">
          <video src="${d.video.master}" muted playsinline preload="metadata"></video>
        </div>
        <div class="video-info">
          <div class="vtitle">主图视频</div>
          <div class="vmeta">点击下方按钮下载为 MP4 文件</div>
        </div>
        <button class="btn btn-primary" id="dlVideoBtn" onclick="downloadVideo('${d.video.stream720}', this)">⬇ 下载视频</button>
      </div>`;
    }
    html += '</div>';
  }

  if (!html) {
    html = '<div class="empty"><div class="icon">📭</div>未采集到有效信息</div>';
  }
  result.innerHTML = html;
}

async function downloadVideo(m3u8, btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 转换中...';
  try {
    const resp = await fetch('/api/video', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: m3u8})
    });
    if (!resp.ok) {
      const j = await resp.json().catch(()=>({}));
      toast(j.error || '下载失败');
      btn.disabled = false;
      btn.textContent = '⬇ 下载视频';
      return;
    }
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'amazon_product_video.mp4';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('视频下载完成');
  } catch(e) {
    toast('下载失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇ 下载视频';
  }
}

// 回车触发
document.getElementById('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') doScrape();
});
</script>
</body>
</html>
"""


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=False)
