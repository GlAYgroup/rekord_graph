import Link from "next/link";
import { CueLine } from "./CuePad";
import { PracticeToggle } from "./PracticeToggle";
import { RatingPicker } from "./RatingPicker";
import { TempoBadge } from "./TempoBadge";
import { TrackTimeline } from "./TrackTimeline";
import { TransitionDetails } from "./TransitionDetails";
import { cueLabel } from "@/lib/format";
import type { Cue, Track, Transition } from "@/lib/types";

export function TransitionCard({
  transition, otherTrack, fromCue, toCue, fromTrackCues, toTrackCues,
  fromDuration, toDuration, currentBpm, href, direction, index = 0, maxOnward = null,
}: {
  transition: Transition;
  otherTrack: Track | undefined;
  fromCue: Cue | undefined;
  toCue: Cue | undefined;
  fromTrackCues: Cue[];
  toTrackCues: Cue[];
  fromDuration: number | null;
  toDuration: number | null;
  currentBpm: number | null;
  href: string;
  direction: "out" | "in";
  index?: number;
  /** この分岐へ進んだ場合、そこから最大何曲つなげられるか（行き先込み） */
  maxOnward?: number | null;
}) {
  // 「出る側」は常に上。in の場合、相手が出る側になる
  const top = { cue: fromCue, cues: fromTrackCues, dur: fromDuration };
  const bottom = { cue: toCue, cues: toTrackCues, dur: toDuration };

  return (
    /*
      カード = 枠（div）+ 中身のリンク + 星の行。
      星は「押して評価を変える」ボタンなので、リンクの中には置けない
      （入れ子の操作要素は HTML として壊れていて、タップが行き先に吸われる）。
    */
    <div
      className="group rounded-card border border-border bg-linear-to-b from-surface to-surface-2 rise transition-colors hover:border-border-bright active:border-accent/50"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms`, boxShadow: "var(--shadow-card)" }}
    >
      <Link href={href} className="block p-4">
        {/*
          曲名に幅を渡す。札（この先N曲・テンポ・BPM）はどれも縮まないので、同じ行に並べたままだと
          スマホでは曲名が 100px 前後に押し込まれて4行に割れ、長い英単語は札を枠の外へ押し出していた。
          曲名の基準幅（basis-56）が取れないときは、札だけ次の行へ回す（PC では1行のまま）
        */}
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-fg-subtle text-sm shrink-0">{direction === "out" ? "▸" : "◂"}</span>
          <span className="min-w-0 grow basis-56 font-semibold text-[18px] break-words">{otherTrack?.name ?? "不明な曲"}</span>
          {direction === "out" && maxOnward !== null && (
            maxOnward > 1 ? (
              <span
                className="shrink-0 rounded border border-hot/35 bg-hot/10 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-hot"
                title="この分岐へ進んだ場合、そこから最大何曲つなげられるか"
              >
                この先{maxOnward}曲
              </span>
            ) : (
              <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-subtle">
                行き止まり
              </span>
            )
          )}
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            <TempoBadge from={currentBpm} to={otherTrack?.bpm ?? null} />
            <span className="whitespace-nowrap font-mono text-[11px] text-fg-subtle tabular-nums">
              {otherTrack?.bpm ?? "–"}{otherTrack?.musicalKey && ` ${otherTrack.musicalKey}`}
            </span>
          </span>
        </div>

        <div className="space-y-2">
          <CueLine cue={top.cue} />
          <TrackTimeline durationSec={top.dur} cues={top.cues} highlightCueId={top.cue?.id ?? ""} mode="exit" />

          <div className="flex items-center gap-2 py-0.5 pl-[18px] text-fg-subtle">
            <span className="text-[13px]">↓</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <CueLine cue={bottom.cue} />
          <TrackTimeline durationSec={bottom.dur} cues={bottom.cues} highlightCueId={bottom.cue?.id ?? ""} mode="enter" />
        </div>

        <TransitionDetails transition={transition} toCueLabel={cueLabel(toCue)} className="mt-3" />

        {transition.needsReview && (
          <p className="mt-2 text-[13px] text-warn">⚠ rekordbox とズレている可能性があります</p>
        )}
      </Link>

      {/*
        練習直後に「今の良かった」を1タップで残す。入力画面まで戻らせない。
        隣に「編集」を置く: キューの取り違えに気づくのは、この曲を見ている今なので、
        どのキュー同士を結ぶかをここから直しに行けるようにする（入力画面が開く）。
        パフォーマンスモードでは行ごと消える（data-edit）
      */}
      <div data-edit className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-4 py-1.5">
        <span className="label">評価</span>
        <RatingPicker id={transition.id} value={transition.rating} className="-my-0.5 ml-auto" />
        {/*
          スマホでは星（180px）と要練習・編集が1行に収まらない。ばらばらに折り返すと
          「編集」だけが次の行の左端に落ちていたので、要練習と編集はひとまとめにして
          次の行の右端へ落とす（1段目 = 評価と星、2段目 = 操作）。PC では星の隣に並ぶ
        */}
        <span className="ml-auto flex items-center gap-2 sm:ml-0">
          <PracticeToggle id={transition.id} value={transition.practice} />
          <Link
            href={`/new?edit=${transition.id}`}
            className="tap inline-flex items-center shrink-0 rounded-full border border-border px-3 text-[12px] text-fg-subtle transition-colors hover:border-border-bright hover:text-fg"
            title="この繋ぎのキュー・種類・コメントを直す"
          >
            編集
          </Link>
        </span>
      </div>
    </div>
  );
}
