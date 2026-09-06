"use client";

import { useEffect } from "react";

/**
 * Service Worker を登録する（ホーム画面から開いたときに回線が切れても画面が出るように）。
 *
 * 開発中は登録しない。dev の差し替え（HMR）とキャッシュがぶつかって、
 * 直したはずのものが出ない、という一番たちの悪い状態になるため。
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => { /* 使えなくても素のアプリとして動く */ });
  }, []);
  return null;
}
