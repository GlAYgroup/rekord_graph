import { bpmDelta } from "@/lib/format";

/**
 * テンポ差。±3% 以内ならピッチをほぼ触らずに合う。
 * 「その繋ぎが今できるか」の判断はこの数字なので、**しきい値の正本はここ1箇所**。
 */
export function TempoBadge({ from, to }: { from: number | null; to: number | null }) {
  const d = bpmDelta(from, to);
  if (d === null) return null;
  const easy = Math.abs(d) <= 3;
  return (
    <span
      className={`font-mono text-[11px] tabular-nums rounded px-1.5 py-0.5 border ${
        easy ? "text-accent border-accent/40 bg-accent/10" : "text-fg-subtle border-border"
      }`}
      title={easy ? "ピッチをほぼ触らずに合う" : "ピッチ調整が要る"}
    >
      {d >= 0 ? "+" : ""}{d.toFixed(1)}%
    </span>
  );
}
