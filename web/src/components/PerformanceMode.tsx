"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

/**
 * パフォーマンスモード = **本番でプレイしている最中に開くための、書き換えられない状態。**
 *
 * DJ 中にこのアプリを見る目的は「次にどのパッドを押すか」を読むことだけで、
 * 記録を直すことではない。にもかかわらず画面には編集の入口（繋ぎを追加・編集・
 * 星・配置の保存）が並んでいて、片手・暗所・急いでいる状況ではどれも誤爆する。
 * 誤爆すると Notion の記録が本番中に書き換わる（星が変わる、配置が上書きされる）。
 *
 * そこで **編集の入口を全部畳むモード**を用意する。
 *
 * 仕組みは2段構え:
 *  1. 見た目 … 編集の入口には `data-edit` を付けておき、
 *     `globals.css` が `[data-perf="on"] [data-edit]` を消す。
 *     サーバで描いている画面（曲ページなど）も、これで一律に畳める
 *  2. 動き   … 「押さなくても起きてしまう書き込み」だけは JS で止める。
 *     グラフのノードは指が当たっただけで動き、1.2秒後に配置が Notion へ保存される。
 *     これは CSS では止まらないので `GraphExplorer` が自分で見て止める
 *
 * 状態は端末ごと（localStorage）。「今この端末が本番中か」は端末の事情なので、
 * Notion に持たない。
 *
 * ★ 本番中は**画面を消灯させない**（Screen Wake Lock。`useScreenWakeLock`）。
 *   プレイ中は画面に触らない時間が長く、次の繋ぎを読もうとした瞬間に画面が消えていると、
 *   暗いブースでロック解除からやり直すことになる。本番を切ったら離す。
 */

const STORAGE = "rg.performance.v1";
/** 同じタブの中で切り替えを知らせる合図（`storage` は他のタブにしか飛ばない） */
const EVENT = "rg-performance-change";

const subscribe = (onChange: () => void) => {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
};

const read = (): boolean => {
  try { return localStorage.getItem(STORAGE) === "on"; } catch { return false; }
};

type PerformanceState = { on: boolean; toggle: () => void };

const Ctx = createContext<PerformanceState>({ on: false, toggle: () => {} });

export function PerformanceProvider({ children }: { children: React.ReactNode }) {
  // サーバ側は常に「通常モード」として描く（端末の設定は読めない）。
  // 読み込み後に localStorage の値へ切り替わる = ハイドレーションが食い違わない
  const on = useSyncExternalStore(subscribe, read, () => false);

  const toggle = useCallback(() => {
    try { localStorage.setItem(STORAGE, read() ? "off" : "on"); } catch { /* 使えなければ何もしない */ }
    window.dispatchEvent(new Event(EVENT));
  }, []);

  useScreenWakeLock(on);

  const value = useMemo(() => ({ on, toggle }), [on, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const usePerformance = () => useContext(Ctx);

/**
 * `on` の間だけ画面の消灯を止める。
 * - タブを裏に回すとブラウザが勝手に離すので、表に戻ったとき（`visibilitychange` → visible）に取り直す
 * - 未対応の端末（古い iOS など）・電池節約モードで断られたときは**黙って諦める**（本番の邪魔をしない）
 * - 取りに行っている途中に切られたら、届いた分はその場で離す（取り残すと消灯しないままになる）
 */
function useScreenWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let pending = false;
    let disposed = false;
    const acquire = async () => {
      if (pending || document.visibilityState !== "visible" || (sentinel && !sentinel.released)) return;
      pending = true;
      try {
        const s = await navigator.wakeLock.request("screen");
        if (disposed) { s.release().catch(() => {}); return; }
        sentinel = s;
      } catch {
        /* 未対応・断られた: 何もしない */
      } finally {
        pending = false;
      }
    };
    const onVisibility = () => { if (document.visibilityState === "visible") void acquire(); };
    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [on]);
}

/** 本番中であることを画面上端の細い線で出す。DJ 中に「今どっちか」を一目で分かるように */
export function PerformanceBar() {
  const { on } = usePerformance();
  if (!on) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-40 h-[2px] bg-hot"
      style={{ boxShadow: "0 0 10px 1px rgb(245 165 36 / 0.6)" }}
    />
  );
}

/**
 * 切り替えボタン。PC は左レールの中、スマホは**画面右上に常設のスイッチ**（`corner`）。
 * どちらもグラフを全画面で見ている最中でも押せる位置。
 * スマホで下タブに並べていた頃は、画面を移るタブと見分けが付かなかった — これは移動ではなく
 * オン/オフなので、スイッチの形にして上端の琥珀の線（`PerformanceBar`）と同じ場所に置く。
 * 右上の幅ぶんは各画面の1行目が `pr-corner` で空けている（ボタンが下に潜らないように）。
 * 本番中は琥珀で光らせる = 押せば戻れることが分かる。
 */
export function PerformanceToggle({ variant }: { variant: "rail" | "corner" }) {
  const { on, toggle } = usePerformance();
  const icon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M10.3 8.9 15.4 12l-5.1 3.1z" fill="currentColor" stroke="none" />
    </svg>
  );
  const label = <span className="text-[10px] tracking-wide">本番</span>;
  const title = on ? "パフォーマンスモードを解除する（編集できるようになります）" : "パフォーマンスモード = 編集の入口を全部畳む（本番用）";

  if (variant === "rail") {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-pressed={on}
        title={title}
        className={`flex w-14 flex-col items-center gap-1 rounded-lg py-2.5 transition-colors ${
          on ? "bg-hot/12 text-hot" : "text-fg-subtle hover:bg-surface hover:text-fg-muted"
        }`}
      >
        {icon}
        {label}
      </button>
    );
  }
  // 押せる範囲は 44px 四方以上（見た目のピルより広く取る。暗所で指がずれても入るように）
  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={on}
      aria-label="本番（パフォーマンスモード）"
      title={title}
      className="fixed right-1.5 top-[env(safe-area-inset-top,0px)] z-40 flex h-11 items-center px-1.5 md:hidden"
    >
      <span
        className={`flex h-8 items-center gap-1.5 rounded-full border pl-2.5 pr-1 text-[12px] font-semibold tracking-wide backdrop-blur-md transition-colors ${
          on ? "border-hot/70 bg-hot/15 text-hot" : "border-border-bright bg-bg/85 text-fg-subtle"
        }`}
        style={on ? { boxShadow: "var(--glow-hot)" } : undefined}
      >
        本番
        {/* スイッチのつまみ。右 = オン */}
        <span className={`relative h-5 w-8 rounded-full transition-colors ${on ? "bg-hot" : "bg-elevated"}`}>
          <span
            className={`absolute top-0.5 size-4 rounded-full transition-all ${
              on ? "left-[14px] bg-hot-fg" : "left-0.5 bg-fg-subtle"
            }`}
          />
        </span>
      </span>
    </button>
  );
}
