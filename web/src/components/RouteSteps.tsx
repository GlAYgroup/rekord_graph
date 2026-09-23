import { barsLabel, cueLabel } from "@/lib/format";
import type { Cue, Track, Transition } from "@/lib/types";

/**
 * 道筋（曲の並びと、その間の繋ぎ）を**上から順に**読む形で出す。
 * 「セットを組む」の結果と、/play の曲を選ぶ一覧の「最大◯曲」を開いたときの1実装。
 * 繋ぎは曲と曲の間に、どのキューからどのキューへ・何小節前（後）からかを添える。
 *
 * `marked` を渡すと、そこに入っている曲を強く出し、それ以外に「挟む曲」と添える（セットを組む用）。
 */
export function RouteSteps({
  trackIds, edges, trackById, cueById, marked,
}: {
  trackIds: readonly string[];
  /** `edges[i]` が `trackIds[i]` → `trackIds[i+1]` */
  edges: readonly Transition[];
  trackById: ReadonlyMap<string, Track>;
  cueById: ReadonlyMap<string, Cue>;
  marked?: ReadonlySet<string>;
}) {
  return (
    <ol className="space-y-1">
      {trackIds.map((id, i) => {
        const via = i > 0 ? edges[i - 1] : null;
        const toCue = via ? cueLabel(cueById.get(via.toCueId)) : "";
        const bars = via ? barsLabel(via, toCue) : null;
        const strong = marked ? marked.has(id) : true;
        return (
          <li key={`${id}-${i}`}>
            {via && (
              <p className="ml-7 border-l border-border py-1 pl-3 text-[12px] text-fg-subtle">
                {cueLabel(cueById.get(via.fromCueId))} → {toCue}
                {bars && ` · ${bars}`}
              </p>
            )}
            <div className="flex items-baseline gap-2">
              <span className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-subtle">{i + 1}</span>
              <span className={`min-w-0 break-words text-[15px] ${marked ? (strong ? "font-semibold text-accent" : "text-fg-muted") : ""}`}>
                {trackById.get(id)?.name ?? "不明な曲"}
              </span>
              {!strong && <span className="shrink-0 text-[11px] text-fg-subtle">挟む曲</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
