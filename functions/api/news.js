// 地理探究・交渉ライブラリー: 選択中の国・国際組織に関する最新ニュースをGoogle Newsの
// RSSフィードから取得して返すプロキシ。ブラウザから直接news.google.comへfetchすると
// CORSで拒否されるため、Cloudflare Pages Functions(サーバー側)経由で取得する。
// APIキー不要・追加の有料サービスなし。

export async function onRequestGet(context) {
  const { request, waitUntil } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  if (!q) {
    return jsonResponse({ error: 'missing q' }, 400);
  }

  // Google Newsの無料RSSは時々一時的な503を返すため、同じ検索語はCloudflareのエッジキャッシュに
  // 乗せて再利用し(生徒が同じ国を選ぶたびに毎回叩かないようにする)、キャッシュが無い場合も
  // 一度だけ短い間隔を置いて再試行してから失敗を返す。
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(rssUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiplomaticIntelPortal/1.0; +https://diplomatic-intel-portal.pages.dev/)' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
      const xml = await res.text();
      const items = parseGoogleNewsRss(xml).slice(0, 10);
      const response = jsonResponse({ query: q, items }, 200, 'public, max-age=900');
      waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await sleep(400);
    }
  }
  return jsonResponse({ error: 'fetch_failed', message: String(lastErr && lastErr.message || lastErr) }, 502);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// GoogleニュースのRSSはDOM APIを持たないWorkers環境でも扱えるよう、正規表現で
// <item>...</item>ブロックを素朴に抜き出す(フィード構造が単純・安定しているため)。
function parseGoogleNewsRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const titleRaw = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const linkRaw = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pubDateRaw = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const sourceRaw = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1];
    if (!titleRaw || !linkRaw) continue;
    const link = decodeEntities(linkRaw.trim());

    const source = sourceRaw ? decodeEntities(sourceRaw.trim()) : '';
    let title = decodeEntities(titleRaw.trim());
    // Googleニュースはタイトル末尾に " - 媒体名" を付与するため、sourceと重複する分は取り除く。
    if (source && title.endsWith(` - ${source}`)) {
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
