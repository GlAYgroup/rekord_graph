/*
 * ブースの回線が切れても、直前に見ていた画面は出るようにするための Service Worker。
 *
 * 方針は「**嘘の情報を出さない**」が最優先:
 *  - 画面と RSC は**ネットワーク優先**。繋がっている限り必ず Notion の最新が出る。
 *    キャッシュを返すのは取りに行って失敗したときだけ
 *  - `/api/` は素通し。書き込み（繋ぎの追加・星・配置）にキャッシュを挟まない
 *  - GET 以外も素通し
 *  - `/_next/static/` はビルドごとに URL が変わるのでキャッシュ優先で構わない
 *  - 画面の読み込み（navigate）が落ちたときは、同じパスの **HTML** を探して出す（`?path=` 違いも可。
 *    RSC の中身 `?_rsc=` を画面として出さない）。Next はアプリ内の移動で RSC が取れないと
 *    ブラウザの通常の読み込みへ切り替えるので、オフラインの移動もここに落ちてくる
 *  - 「オフライン用に準備」（`OfflinePrep`）からの `{ type: "prefetch", urls }` で、画面の HTML と
 *    その画面が読む `/_next/static/` を先に入れておく。進み具合は `event.ports[0]` へ返す
 *
 * 版を上げると古いキャッシュは activate で全部消える。
 */
const VERSION = "v1";
const CACHE = `rekord-graph-${VERSION}`;

self.addEventListener("install", () => {
  self.skipWaiting(); // 新しい版が来たらすぐ入れ替える（古い画面に閉じ込めない）
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/** 入れられないもの（opaque・部分応答・Vary:*）で落ちないように包む */
async function put(request, response) {
  try {
    if (!response || !response.ok || response.type === "opaque") return;
    const cache = await caches.open(CACHE);
    await cache.put(request, response);
  } catch { /* 入らなければ諦める。表示には影響しない */ }
}

/** 画面の読み込みが落ちたときの代わり。まず同じ URL、無ければ同じパスの HTML */
async function fallbackPage(req) {
  const exact = await caches.match(req, { ignoreVary: true });
  if (exact && isHtml(exact)) return exact;
  const cache = await caches.open(CACHE);
  const same = await cache.matchAll(req, { ignoreSearch: true, ignoreVary: true });
  return same.find(isHtml) ?? null;
}
const isHtml = (res) => (res.headers.get("content-type") ?? "").includes("text/html");

/** HTML が読む `/_next/static/` の JS・CSS・フォント（RSC の文字列の中に `\"` 付きで出るものも拾う） */
function staticAssets(html) {
  const found = new Set();
  for (const m of html.matchAll(/\/_next\/static\/[^"'\s)\\<>]+/g)) found.add(m[0]);
  return [...found];
}

/** 画面を順に取りに行って入れる。同時に取りに行くのは3本まで（画面ごとにサーバが Notion を読むため） */
async function prefetch(urls, port) {
  const cache = await caches.open(CACHE);
  const assets = new Set();
  let done = 0;
  let failed = 0;
  const report = (finished) => port?.postMessage({ type: "progress", done, failed, total: urls.length, finished });
  const queue = [...urls];
  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      try {
        const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
        if (!res.ok || !isHtml(res)) throw new Error(String(res.status));
        const html = await res.clone().text();
        await cache.put(new Request(url), res);
        for (const a of staticAssets(html)) assets.add(a);
        done++;
      } catch {
        failed++;
      }
      report(false);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  // 画面が読む JS・CSS。入っていなければ取りに行く（ビルドごとに URL が変わるので、入っていれば同じもの）
  await Promise.all([...assets].map(async (a) => {
    try {
      if (await cache.match(a)) return;
      const res = await fetch(a);
      if (res.ok) await cache.put(a, res);
    } catch { /* 1つ欠けても画面の HTML は出る */ }
  }));
  report(true);
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "prefetch" || !Array.isArray(data.urls)) return;
  // 同じオリジンの画面だけ。`/api/` は入れない（素通しの約束）
  const urls = data.urls.filter((u) => {
    try {
      const url = new URL(u, self.location.origin);
      return url.origin === self.location.origin && !url.pathname.startsWith("/api/");
    } catch { return false; }
  });
  // 終わるまで Service Worker を止めさせない
  event.waitUntil(prefetch(urls, event.ports[0]));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        put(req, res.clone());
        return res;
      } catch (err) {
        if (req.mode === "navigate") {
          const page = await fallbackPage(req);
          if (page) return page;
        }
        const hit = await caches.match(req);
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
