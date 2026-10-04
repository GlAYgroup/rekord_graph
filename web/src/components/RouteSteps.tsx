import { barsLabel, bpmDelta, cueLabel, cueOf } from "@/lib/format";
import { KEY_MATCH_LABEL, KEY_MATCH_TITLE, keyMatch } from "@/lib/key";
import type { Cue, Track, Transition } from "@/lib/types";

/** 記録の無い間に添える「BPM+2.1% · キー◎」。キーが読めなければ言わない */
function unrecordedLabel(from: Track | undefined, to: Track | undefined): { text: string; title?: string } {
  const d = bpmDelta(from?.bpm ?? null, to?.bpm ?? null);
  const bpm = d == null ? "BPM ?" : `BPM${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}%`;
  const k = keyMatch(from?.musicalKey, to?.musicalKey);
  return { text: `記録なし · ${bpm}${k ? ` · ${KEY_MATCH_LABEL[k]}` : ""}`, title: k ? KEY_MATCH_TITLE[k] : undefined };
}

/**
 * 道筋（曲の並びと、その間の繋ぎ）を**上から順に**読む形で出す。
 * 「セットを組む」の結果と、/play の曲を選ぶ一覧の「最大◯曲」を開いたときの1実装。
 * 繋ぎは曲と曲の間に、どのキューからどのキューへ・何小節前（後）からかを添える。
 *
 * `marked` を渡すと、そこに入っている曲を強く出し、それ以外に「挟む曲」と添える（セットを組む用）。
 * 間が `null` なら繋ぎの記録が無い（セットを組むの「差し込む」）。BPM の差とキーの相性を添えて出し、
 * `inserted` に入っている曲には「差し込み」と添える。
 */
export function RouteSteps({
  trackIds, edges, trackById, cueById, marked, inserted,
}: {
  trackIds: readonly string[];
  /** `edges[i]` が `trackIds[i]` → `trackIds[i+1]`。記録の無い間は null */
  edges: readonly (Transition | null)[];
  trackById: ReadonlyMap<string, Track>;
  cueById: ReadonlyMap<string, Cue>;
  marked?: ReadonlySet<string>;
  inserted?: ReadonlySet<string>;
}) {
  return (
    <ol className="space-y-1">
      {trackIds.map((id, i) => {
        const via = i > 0 ? edges[i - 1] : null;
        const toCue = via ? cueLabel(cueOf(cueById, via.toCueId)) : "";
        const bars = via ? barsLabel(via, toCue) : null;
        const strong = marked ? marked.has(id) : true;
        const gap = i > 0 && !via ? unrecordedLabel(trackById.get(trackIds[i - 1]), trackById.get(id)) : null;
        return (
          <li key={`${id}-${i}`}>
            {via && (
              <p className="ml-7 border-l border-border py-1 pl-3 text-[12px] text-fg-subtle">
                {cueLabel(cueOf(cueById, via.fromCueId))} → {toCue}
                {bars && ` · ${bars}`}
              </p>
            )}
            {gap && (
              <p title={gap.title} className="ml-7 border-l border-dashed border-border py-1 pl-3 text-[12px] text-fg-muted">
                {gap.text}
              </p>
            )}
            <div className="flex items-baseline gap-2">
              <span className="w-5 shrink-0 text-right font-mono text-[12px] tabular-nums text-fg-subtle">{i + 1}</span>
              <span className={`min-w-0 break-words text-[15px] ${marked ? (strong ? "font-semibold text-accent" : "text-fg-muted") : ""}`}>
                {trackById.get(id)?.name ?? "不明な曲"}
              </span>
              {inserted?.has(id) ? (
                <span className="shrink-0 rounded border border-border px-1.5 text-[12px] text-fg-muted">差し込み</span>
              ) : (
                !strong && <span className="shrink-0 text-[12px] text-fg-subtle">挟む曲</span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
