import { CueLine } from "./CuePad";
import { TrackTimeline } from "./TrackTimeline";
import { DIFFICULTY_LABEL, type Difficulty } from "@/lib/difficulty";
import { barsLabel, cueLabel } from "@/lib/format";
import type { Cue, Track, Transition } from "@/lib/types";

/**
 * 1本の繋ぎの中身 = **どのキューから抜けて、どのキューへ入るか・曲のどこか・どう繋ぐか（メモは全文）**。
 * /play のカードと、プレイリストのプレイ画面（`PlaylistPlayer`）の1実装。
 * プレイ中に読むものなので、キュー名もメモも省略しない。
 */
export function HopDetails({
  t, from, to, cueById, cuesByTrack, showRating,
}: {
  t: Transition;
  from: Track | undefined;
  to: Track | undefined;
  cueById: ReadonlyMap<string, Cue>;
  cuesByTrack: ReadonlyMap<string, Cue[]>;
  /** 星の印を出すか（/play の下見中は押せる星が別にあるので出さない） */
  showRating: boolean;
}) {
  const fromCue = cueById.get(t.fromCueId);
  const toCue = cueById.get(t.toCueId);
  const bars = barsLabel(t, cueLabel(toCue));
  return (
    <div className="min-w-0 space-y-2 sm:flex-1">
      <CueLine cue={fromCue} size="sm" />
      <TrackTimeline
        durationSec={from?.durationSec ?? null}
        cues={cuesByTrack.get(t.fromTrackId) ?? []}
        highlightCueId={t.fromCueId}
        mode="exit"
      />
      <div className="flex items-center gap-2 py-0.5 pl-[18px] text-fg-subtle">
        <span className="text-[13px]">↓</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <CueLine cue={toCue} size="sm" />
      <TrackTimeline
        durationSec={to?.durationSec ?? null}
        cues={cuesByTrack.get(t.toTrackId) ?? []}
        highlightCueId={t.toCueId}
        mode="enter"
      />

      {(t.technique || t.difficulty || (showRating && t.rating) || bars || t.comment) && (
        <div className="space-y-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-2">
            {/* 除外条件の根拠が画面に無いと、なぜ残ったか読めない */}
            {t.difficulty && (
              <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-muted">
                {DIFFICULTY_LABEL[t.difficulty as Difficulty] ?? t.difficulty}
              </span>
            )}
            {showRating && t.rating && <span className="text-[11.5px] text-warn">{t.rating}</span>}
            {t.technique && (
              <span className="rounded border border-border-bright bg-elevated px-1.5 py-0.5 text-[11px] text-fg">
                {t.technique}
              </span>
            )}
            {bars && <span className="text-[11.5px] tabular-nums text-fg-subtle">{bars}</span>}
          </div>
          {/* メモは**省略しない**。改行もそのまま出す（プレイ中に読む本文） */}
          {t.comment && (
            <p className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-fg">{t.comment}</p>
          )}
        </div>
      )}
    </div>
  );
}
