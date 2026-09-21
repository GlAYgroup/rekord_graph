import Link from "next/link";
import { PracticeToggle } from "@/components/PracticeToggle";
import { RatingPicker } from "@/components/RatingPicker";
import { barsLabel, cueLabel } from "@/lib/format";
import { getGraph } from "@/lib/graph";

export const metadata = { title: "練習 | rekord_graph" };

/**
 * 要練習マークの付いた繋ぎだけを並べる練習チェックリスト。
 *
 * マークは曲ページ・グラフ・この画面の「要練習」ボタンで付け外しする。
 * 練習して仕上がったらここで外す = リストが空になったら今日の練習は終わり、
 * という使い方を想定している。行から曲ページへ飛べば波形・キュー込みのカードで見られる。
 */

/** 曲名の後ろに添える BPM。曲名の一部として折り返させたいので inline で置く
    （ただし数字と「BPM」の間では割らない） */
const Bpm = ({ value }: { value: number | null }) => (
  <span className="ml-1.5 whitespace-nowrap font-mono text-[11px] tabular-nums text-fg-subtle">
    {value ?? "–"}
    <span className="ml-0.5 text-[9px] tracking-wide">BPM</span>
  </span>
);

export default async function PracticePage() {
  const g = await getGraph();
  const rows = g.transitions
    .filter((t) => t.practice)
    .sort((a, b) => b.createdTime.localeCompare(a.createdTime));

  return (
    // relative z-1: 全面に敷いた .grain（fixed・z-index 0）より上に文字を置く（他の画面と同じ）
    <main className="relative z-1 mx-auto max-w-[820px] px-4 pb-nav pt-5 md:pb-16">
      <h1 className="text-[22px] font-bold leading-tight">要練習の繋ぎ · {rows.length}</h1>
      <p className="mt-1 text-[13px] text-fg-muted">
        曲ページ・グラフ・ここの「要練習」ボタンで付け外しできます。仕上がったら外して、空にするのが今日のゴール。
      </p>

      <ul className="mt-5 space-y-2">
        {rows.map((t) => {
          const from = g.trackById.get(t.fromTrackId);
          const to = g.trackById.get(t.toTrackId);
          const toCue = g.cueById.get(t.toCueId);
          return (
            <li key={t.id} className="rounded-card border border-border bg-surface">
              {/* 行の本体は From の曲ページへ。波形・キュー込みのカードはそちらで見る */}
              <Link href={`/track/${t.fromTrackId}`} className="block px-4 py-3 transition-colors hover:bg-surface-2">
                <span className="block text-[15px] break-words">
                  {from?.name ?? "?"}<Bpm value={from?.bpm ?? null} />{" "}
                  <span className="text-hot">→</span> {to?.name ?? "?"}<Bpm value={to?.bpm ?? null} />
                </span>
                <span className="mt-0.5 block font-mono text-[11.5px] text-fg-subtle break-words">
                  {cueLabel(g.cueById.get(t.fromCueId))} → {cueLabel(toCue)}
                </span>
                {(t.technique || barsLabel(t, cueLabel(toCue)) || t.comment) && (
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-fg-muted">
                    {t.technique && (
                      <span className="rounded border border-border-bright bg-elevated px-1.5 py-0.5 text-[11px] text-fg">
                        {t.technique}
                      </span>
                    )}
                    {barsLabel(t, cueLabel(toCue)) && (
                      <span className="text-[11px] text-fg-subtle tabular-nums">{barsLabel(t, cueLabel(toCue))}</span>
                    )}
                    {t.comment && <span className="break-words">{t.comment}</span>}
                  </span>
                )}
              </Link>
              <div data-edit className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-1">
                <RatingPicker id={t.id} value={t.rating} size="sm" className="ml-auto" />
                <PracticeToggle id={t.id} value={t.practice} />
                <Link
                  href={`/new?edit=${t.id}`}
                  className="tap inline-flex items-center shrink-0 rounded-full border border-border px-3 text-[12px] text-fg-subtle transition-colors hover:border-border-bright hover:text-fg"
                >
                  編集
                </Link>
              </div>
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="rounded-card border border-dashed border-border p-8 text-center text-[13.5px] text-fg-subtle">
            要練習の繋ぎはありません。曲ページやグラフの「要練習」を押すと、ここに並びます。
          </li>
        )}
      </ul>
    </main>
  );
}
