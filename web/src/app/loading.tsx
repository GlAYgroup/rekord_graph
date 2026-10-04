/**
 * 画面を移る途中に出す仮の画面（全画面共通）。
 *
 * 曲・グラフ・プレイなどはサーバで Notion の記録から組み立てるので、本番では数秒かかることがある。
 * これが無いと、タブを押しても前の画面のまま固まって見え、押せていないのか待っているのかが
 * 分からなかった。押した瞬間にこちらへ切り替わる（タブのアイコンも回る。`AppShell` の `TabIcon`）
 */
export default function Loading() {
  return (
    <main className="relative z-1 grid min-h-[60vh] place-items-center px-4 pb-nav" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-3 text-fg-subtle">
        <svg viewBox="0 0 24 24" fill="none" className="size-8 animate-spin text-accent" aria-hidden>
          <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
          <path d="M12 3.8a8.2 8.2 0 0 1 8.2 8.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="text-[13px]">読み込み中…</span>
      </div>
    </main>
  );
}
