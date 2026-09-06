/*
 * ブースの回線が切れても、直前に見ていた画面は出るようにするための Service Worker。
 *
 * 方針は「**嘘の情報を出さない**」が最優先:
 *  - 画面と RSC は**ネットワーク優先**。繋がっている限り必ず Notion の最新が出る。
 *    キャッシュを返すのは取りに行って失敗したときだけ
 *  - `/api/` は素通し。書き込み（繋ぎの追加・星・配置）にキャッシュを挟まない
 *  - GET 以外も素通し
 *  - `/_next/static/` はビルドごとに URL が変わるのでキャッシュ優先で構わない
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
        const hit = await caches.match(req);
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
