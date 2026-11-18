const axios = require('axios');
const cheerio = require('cheerio');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};
(async () => {
  const url = 'https://www.amazon.com/dp/B0F1TFC28B?language=zh_TW&currency=CNY';
  const instance = axios.create({ headers: HEADERS, timeout: 40000 });
  try { await instance.get('https://www.amazon.com', { timeout: 20000 }); } catch(e){}
  await new Promise(r => setTimeout(r, 1500));
  const r = await instance.get(url);
  if (r.data.includes('validateCaptcha')) { console.log('CAPTCHA'); return; }
  const $ = cheerio.load(r.data);
  // 搜索包含'總計'或'总计'的元素
  $('*').each((_, el) => {
    const t = ($(el).text() || '').trim();
    if (t === '總計' || t === '总计' || t.startsWith('總計') || t.startsWith('总计')) {
      console.log('FOUND label tag:', el.tagName, 'text:', JSON.stringify(t.slice(0, 80)));
      console.log('  parent html:', $(el).parent().html().slice(0, 400));
      console.log('---');
    }
  });
  console.log('=== apexPriceToPay ===');
  console.log($('.apexPriceToPay').html() || 'none');
  console.log('=== a-offscreen in centerCol/buybox ===');
  $('#buybox .a-offscreen, #centerCol .a-offscreen').each((i, el) => console.log(i, $(el).text()));
})().catch(e => console.log('ERR', e.message));
