import { cueLabel } from "@/lib/format";
import type { Cue } from "@/lib/types";

/**
 * 曲1本を1本のタイムラインとして描く。この画面の中核。
 *
 * 「どのパッドを押すか」の次に知りたいのは「曲のどのへんか」。
 * 数字（2:36.133）だけでは体感と結びつかないので、位置関係を目で見えるようにする。
 *
 * 振幅は描かない（波形データを持っていないので、それらしく描くと嘘になる）。
 * 実データだけ = 曲の長さ・キューの位置・1分ごとの目盛り。
 */
export function TrackTimeline({
  durationSec, cues, highlightCueId, mode,
}: {
  durationSec: number | null;
  cues: Cue[];
  highlightCueId: string;
  mode: "exit" | "enter";
}) {
  const highlighted = cues.find((c) => c.id === highlightCueId);
  // 長さが取れない曲は、最後のキュー位置を暫定の終端にする
  const totalMs = (durationSec ?? 0) * 1000
    || Math.max(1, ...cues.map((c) => c.positionMs ?? 0)) * 1.1;
  const at = (ms: number | null) => Math.min(100, Math.max(0, ((ms ?? 0) / totalMs) * 100));
  const hx = at(highlighted?.positionMs ?? null);

  const minuteTicks = Array.from(
    { length: Math.max(0, Math.floor(totalMs / 60000)) },
    (_, i) => ((i + 1) * 60000 / totalMs) * 100,
  );

  return (
    <div className="relative h-7 w-full rounded-md bg-bg-deep border border-border overflow-hidden">
      {/* 再生する側の範囲。exit=ここまで流してきた / enter=ここから流していく */}
      <div
        className="absolute inset-y-0 bg-accent/12"
        style={mode === "exit" ? { left: 0, width: `${hx}%` } : { left: `${hx}%`, right: 0 }}
      />
      {minuteTicks.map((x, i) => (
        <span key={i} className="absolute inset-y-0 w-px bg-border-bright/60" style={{ left: `${x}%` }} />
      ))}

      {/* 他のキュー: 位置関係の文脈として薄く出す */}
      {cues.map((c) =>
        c.id === highlightCueId ? null : (
          <span
            key={c.id}
            className="absolute top-1.5 bottom-1.5 w-px bg-hot/35"
            style={{ left: `${at(c.positionMs)}%` }}
            title={cueLabel(c)}
          />
        ),
      )}

      {/* 使うキュー */}
      {highlighted && (
        <span
          className="absolute inset-y-0 w-[3px] bg-hot"
          style={{ left: `${hx}%`, boxShadow: "0 0 10px 1px rgb(245 165 36 / 0.75)" }}
        />
      )}
    </div>
  );
}
