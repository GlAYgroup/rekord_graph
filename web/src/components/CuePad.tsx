import type { Cue } from "@/lib/types";
import { formatPosition, loopLengthMs, showsLoop } from "@/lib/format";

/**
 * ホットキュー1つ。機材のラバーパッドに寄せた見た目にする。
 * DJ 中に実際に押すのはこの記号なので、画面で一番強い要素にする（DESIGN.md）。
 * 表示するのは rekordbox 実機の記号だけ。Notion のメモ由来の記号は信用しない。
 */
export function CuePad({ cue, size = "md" }: { cue: Cue | undefined; size?: "md" | "sm" }) {
  const big = size === "md";
  if (!cue) {
    return (
      <span className={`grid place-items-center rounded-pad border border-dashed border-warn/50 text-warn ${big ? "size-12" : "size-9"}`}>
        ?
      </span>
    );
  }
  return (
    <span
      className={`relative shrink-0 grid place-items-center rounded-pad bg-linear-to-b from-hot to-hot-deep text-hot-fg font-mono font-semibold tabular-nums select-none ${
        big ? "size-12 text-[26px]" : "size-9 text-lg"
      }`}
      style={{ boxShadow: "var(--glow-hot)" }}
      aria-label={`ホットキュー ${cue.letter ?? "不明"}`}
    >
      {/* パッド上端のハイライト。押せるものに見せる */}
      <span aria-hidden className="absolute inset-x-1 top-0.5 h-1/3 rounded-t-[7px] bg-white/20" />
      <span className="relative">{cue.letter ?? "?"}</span>
    </span>
  );
}

/**
 * ループのキューに添える札。
 *
 * DJ 中に「そこはループか」は押し方が変わる情報なので、記号とキュー名のすぐ隣に出す。
 * 長さは**秒で出す**（小節数は BPM から割り出すと、実データでは
 * `ループ_ドゥドゥドゥ_8小節` が 2.7 秒のように、キュー名と食い違う。キュー名が正）。
 * キュー名が既に「ループ」と言っているキューには出さない（`showsLoop`）。
 */
export function LoopTag({ cue }: { cue: Cue | undefined }) {
  if (!showsLoop(cue)) return null;
  const len = cue ? loopLengthMs(cue) : null;
  return (
    <span
      className="shrink-0 rounded border border-hot/40 bg-hot/10 px-1.5 py-0.5 text-[10.5px] leading-none text-hot"
      title={len ? `ループ ${(len / 1000).toFixed(1)}秒` : "ループ"}
    >
      ループ
    </span>
  );
}

/** パッド＋キュー名＋位置。1行で読める塊。 */
export function CueLine({ cue, size = "md" }: { cue: Cue | undefined; size?: "md" | "sm" }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <CuePad cue={cue} size={size} />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5 text-[17px] leading-snug">
          {/* キュー名は**刈らない**。長ければ折り返す（プレイ中に読む情報なので） */}
          <span className="min-w-0 break-words">
            {cue?.name || <span className="text-fg-subtle">（名前なし）</span>}
          </span>
          <LoopTag cue={cue} />
        </span>
        <span className="block font-mono text-[12px] text-fg-subtle tabular-nums">
          {formatPosition(cue?.positionMs ?? null)}
        </span>
      </span>
    </div>
  );
}
