import { barsLabel, chainLabel } from "@/lib/format";
import { DIFFICULTY_LABEL, type Difficulty } from "@/lib/difficulty";
import type { Transition } from "@/lib/types";

/**
 * 繋ぎの中身（種類・小節数・難易度・チェーン・コメント）を札と本文で並べる。曲ページの
 * 「行ける先」と「入ってこれる曲」の両方で使う（片方だけに項目が出る、を起こさない）。
 * 星と要練習はここに入れない — 曲ページでは同じ行の押すボタンが同じことを言うため。
 *
 * `toCueLabel` は小節数の言い方（`次の曲 C「歌入り」の16小節前`）に使う。出す・出さないも
 * `barsLabel` の結果で決める（`bars != null` で見ると「後」だけの繋ぎが消える）。
 */
export function TransitionDetails({
  transition: t, toCueLabel, className = "",
}: {
  transition: Transition;
  toCueLabel: string;
  className?: string;
}) {
  const bars = barsLabel(t, toCueLabel);
  const hasTags = !!(t.technique || bars || t.difficulty || t.chain);
  if (!hasTags && !t.comment) return null;

  return (
    <div className={className}>
      {hasTags && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {t.technique && (
            <span className="rounded border border-border-bright bg-elevated px-1.5 py-0.5 text-[11px] text-fg">
              {t.technique}
            </span>
          )}
          {bars && <span className="text-[11.5px] tabular-nums text-fg-subtle">{bars}</span>}
          {t.difficulty && (
            <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-muted">
              {DIFFICULTY_LABEL[t.difficulty as Difficulty] ?? t.difficulty}
            </span>
          )}
          {t.chain && (
            <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-muted">
              {chainLabel(t.chain)}
            </span>
          )}
        </p>
      )}
      {/* コメントは改行もそのまま（入力画面で入れたとおりに読む） */}
      {t.comment && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-fg-muted">
          {t.comment}
        </p>
      )}
    </div>
  );
}
