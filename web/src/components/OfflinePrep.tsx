"use client";

import { useState } from "react";

/**
 * 「オフライン用に準備」。ブースの回線が切れてもこのセットを回せるよう、要る画面を
 * Service Worker のキャッシュへ先に入れておく（`public/sw.js` の `prefetch`）。
 *
 * 入れるのは画面の HTML と、その画面が読む `/_next/static/`。キャッシュの名前と入れ方は sw.js だけが知っている
 * （ここからは頼むだけ）。sw.js はネットワーク優先のままなので、繋がっている間は今までどおり最新が出る。
 * Notion には何も書かないので `data-edit` は付けない（本番直前に押せること）。
 */
export function OfflinePrep({ urls, disabledReason }: { urls: readonly string[]; disabledReason?: string | null }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "running" | "done"; done: number; failed: number; total: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const run = async () => {
    const sw = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    const active = sw?.active;
    if (!active) {
      setState({
        kind: "error",
        message: "この端末ではオフライン用の仕組み（Service Worker）がまだ動いていません。本番の URL を一度開き直してから押してください（開発中は動きません）。",
      });
      return;
    }
    setState({ kind: "running", done: 0, failed: 0, total: urls.length });
    const channel = new MessageChannel();
    channel.port1.onmessage = (e: MessageEvent) => {
      const d = e.data as { done: number; failed: number; total: number; finished: boolean };
      setState({ kind: d.finished ? "done" : "running", done: d.done, failed: d.failed, total: d.total });
      if (d.finished) channel.port1.close();
    };
    active.postMessage({ type: "prefetch", urls }, [channel.port2]);
  };

  const busy = state.kind === "running";
  return (
    <div className="mt-3">
      <button
        onClick={run}
        disabled={busy || !!disabledReason || urls.length === 0}
        className="btn w-full rounded-card text-[13.5px]"
      >
        {busy ? `準備中… ${state.done + state.failed}/${state.total}` : "オフライン用に準備"}
      </button>
      <p className={`mt-1 text-[12px] ${state.kind === "error" && !disabledReason ? "text-warn" : "text-fg-subtle"}`}>
        {disabledReason
          ?? (state.kind === "done"
            ? `${state.done}/${state.total}画面を入れました${state.failed > 0 ? `（${state.failed}画面は取れませんでした。もう一度押してください）` : "。回線が切れてもこのセットの画面が開けます"}`
            : state.kind === "error"
              ? state.message
              : `このプレイリストのプレイ画面・曲ページ・/play の${urls.length}画面を端末に入れておきます。`)}
      </p>
    </div>
  );
}
