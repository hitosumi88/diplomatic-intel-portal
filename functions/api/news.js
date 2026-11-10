// 地理探究・交渉ライブラリー: 選択中の国・国際組織に関する最新ニュースを取得して返すプロキシ。
// ブラウザから直接news.google.com等へfetchするとCORSで拒否されるため、
// Cloudflare Pages Functions(サーバー側)経由で取得する。APIキー不要・追加の有料サービスなし。
//
// Cloudflare Workers共有の送信元IPからのアクセスはGoogle News側で時々503(一時的な混雑)を
// 返されることが分かったため、Google Newsを優先しつつ失敗時はBing Newsへフォールバックする
// 二段構えにしてある。

export async function onRequestGet(context) {
  const { request, waitUntil } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  if (!q) {
    return jsonResponse({ error: 'missing q' }, 400);
  }

  // 同じ検索語はCloudflareのエッジキャッシュに乗せて再利用する
  // (生徒が同じ国を選ぶたびに毎回外部へ問い合わせないようにする)。
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const sources = [
    () => fetchGoogleNews(q),
    () => fetchBingNews(q),
  ];
  let lastErr;
  for (const fetchSource of sources) {
    try {
      const items = await fetchSource();
      const response = jsonResponse({ query: q, items }, 200, 'public, max-age=900');
      waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (e) {
      lastErr = e;
    }
  }
  return jsonResponse({ error: 'fetch_failed', message: String(lastErr && lastErr.message || lastErr) }, 502);
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiplomaticIntelPortal/1.0; +https://diplomatic-intel-portal.pages.dev/)' },
    });
    if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoogleNews(q) {
  const xml = await fetchWithTimeout(
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`, 6000
  );
  return parseRssItems(xml, { sourceTag: 'source', stripSourceSuffix: true }).slice(0, 10);
}

async function fetchBingNews(q) {
  const xml = await fetchWithTimeout(
    `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS&setmkt=ja-JP`, 6000
  );
  return parseRssItems(xml, { sourceTag: 'News:Source', stripSourceSuffix: false }).slice(0, 10);
}

function jsonResponse(body, status, cacheControl) {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (cacheControl) headers['cache-control'] = cacheControl;
  return new Response(JSON.stringify(body), { status, headers });
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)));
}

// RSSはDOM APIを持たないWorkers環境でも扱えるよう、正規表現で<item>...</item>ブロックを
// 素朴に抜き出す(Google News・Bing Newsともフィード構造が単純・安定しているため)。
function parseRssItems(xml, { sourceTag, stripSourceSuffix }) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const sourceRegex = new RegExp(`<${sourceTag}[^>]*>([\\s\\S]*?)<\\/${sourceTag}>`);
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const titleRaw = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const linkRaw = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pubDateRaw = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const sourceRaw = (block.match(sourceRegex) || [])[1];
    if (!titleRaw || !linkRaw) continue;
    const link = decodeEntities(linkRaw.trim());

    const source = sourceRaw ? decodeEntities(sourceRaw.trim()) : '';
    let title = decodeEntities(titleRaw.trim());
    // Googleニュースはタイトル末尾に " - 媒体名" を付与するため、sourceと重複する分は取り除く。
    if (stripSourceSuffix && source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3));
    }

    let pubDate = '';
    if (pubDateRaw) {
      const d = new Date(pubDateRaw.trim());
      if (!isNaN(d.getTime())) {
        pubDate = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      }
    }
    items.push({ title, link, pubDate, source });
  }
  return items;
}
