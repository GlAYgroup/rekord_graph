"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { barsLabel, cueLabel } from "@/lib/format";
import { deleteSet, readHistory, type PlaySet } from "@/lib/playlog";
import type { Cue, Track, Transition } from "@/lib/types";

/**
 * 前にかけたセットの一覧。**新しいものが上**、中は**かけた順に上から**。
 *
 * 1行 = 1つの繋ぎ（曲A → 曲B）で、どのキューからどのキューへ繋いだかまで出す。
 * 「曲を変える」で記録に無い曲へ移った所は**繋ぎとして書かない** —
 * 記録に無いものを、あるように見せない。
 *
 * 曲や繋ぎが rekordbox / Notion から消えていても、**その1手は落とさない**
 * （名前だけ「不明な曲」になる）。セットの途中が黙って詰まる方が読めなくなる。
 *
 * 中身は端末だけが持つので、読むのは mount 後（サーバの描画と食い違わせない）。
 */
export function PlayHistory({
  tracks, cues, transitions,
}: {
  tracks: Track[];
  cues: Cue[];
  transitions: Transition[];
}) {
  const [sets, setSets] = useState<PlaySet[] | null>(null);
  /** 削除は2タップ。消した履歴は戻せないので、リセットと同じ作法にする */
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => { setSets(readHistory()); }, []);

  const trackById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);
  const transitionById = useMemo(() => new Map(transitions.map((t) => [t.id, t])), [transitions]);

  return (
    <main className="relative z-1 mx-auto max-w-3xl px-4 pb-nav pt-4">
      <div className="flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-[22px] font-bold tracking-tight">プレイ履歴</h1>
        <Link
          href="/play"
          // リンクは button と違って中身を縦に寄せないので、44px の高さの上端に字が貼り付く
          className="tap inline-flex shrink-0 items-center rounded-full border border-border bg-surface px-3 text-[12.5px] text-fg-subtle hover:text-fg"
        >
          プレイへ
        </Link>
      </div>
      <p className="mt-1 text-[13px] text-fg-muted">
        リセットするたびに、そのセットでどう繋いだかがここに残ります（この端末の中だけ）。
      </p>

      {sets === null ? (
        <p className="label mt-6">読み込み中…</p>
      ) : sets.length === 0 ? (
        <p className="mt-6 rounded-card border border-border bg-surface p-5 text-[14px] text-fg-muted">
          まだ履歴はありません。
          <br />
          プレイ画面で曲を繋いで「リセット」すると、そのセットがここに残ります
          （2曲以上つないだものだけ）。
        </p>
      ) : (
        <ul className="mt-4 space-y-4">
          {sets.map((set) => (
            <li key={set.id} className="rounded-card border border-border bg-surface">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
                <span className="font-mono text-[13px] tabular-nums text-fg">
                  {new Date(set.endedAt).toLocaleString("ja-JP", {
                    year: "numeric", month: "numeric", day: "numeric",
                    hour: "2-digit", minute: "2-digit",
                  })}
                </span>
                <span className="text-[12.5px] text-fg-muted">
                  {set.steps.length}曲 · {Math.max(0, set.steps.length - 1)}回つないだ
                </span>
                <span className="ml-auto flex items-center gap-2">
                  {confirmId === set.id ? (
                    <>
                      <button
                        onClick={() => { setSets(deleteSet(set.id)); setConfirmId(null); }}
                        className="tap rounded-full border border-warn/50 bg-warn/10 px-3 text-[12px] text-warn"
                      >
                        消す
                      </button>
                      <button
                        onClick={() => setConfirmId(null)}
                        className="tap rounded-full border border-border px-3 text-[12px] text-fg-subtle hover:text-fg"
                      >
                        やめる
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmId(set.id)}
                      className="tap rounded-full border border-border px-3 text-[12px] text-fg-subtle hover:text-fg"
                    >
                      削除
                    </button>
                  )}
                </span>
              </div>

              {/* 1行 = 1つの繋ぎ。最初の曲は行の左側に出るので、2手目から並べる */}
              <ol className="divide-y divide-border">
                {set.steps.slice(1).map((step, i) => {
                  const fromId = set.steps[i].trackId;
                  const from = trackById.get(fromId);
                  const to = trackById.get(step.trackId);
                  const via = step.viaTransitionId
                    ? transitionById.get(step.viaTransitionId)
                    : undefined;
                  const toCueLabel = via ? cueLabel(cueById.get(via.toCueId)) : "";
                  return (
                    <li key={`${set.id}-${i}`} className="px-4 py-2.5">
                      <div className="flex items-baseline gap-2 text-[14.5px]">
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                          {i + 1}
                        </span>
                        <Link
                          href={`/track/${fromId}`}
                          className="min-w-0 break-words hover:text-accent"
                        >
                          {from?.name ?? "不明な曲"}
                        </Link>
                        <span className="shrink-0 text-fg-subtle">→</span>
                        <Link
                          href={`/track/${step.trackId}`}
                          className="min-w-0 break-words font-semibold hover:text-accent"
                        >
                          {to?.name ?? "不明な曲"}
                        </Link>
                      </div>
                      {via ? (
                        <div className="mt-0.5 pl-[18px]">
                          <span className="font-mono text-[11.5px] break-words text-fg-subtle">
                            {cueLabel(cueById.get(via.fromCueId))} → {toCueLabel}
                          </span>
                          {(via.technique || barsLabel(via, toCueLabel)) && (
                            <span className="ml-2 text-[11.5px] text-fg-muted">
                              {via.technique}
                              {via.technique && barsLabel(via, toCueLabel) && " · "}
                              {barsLabel(via, toCueLabel)}
                            </span>
                          )}
                        </div>
                      ) : (
                        <div className="mt-0.5 pl-[18px] text-[11.5px] text-fg-subtle">
                          {/* 繋ぎ ID が無い = その場で別の曲へ移った。
                              ID はあるのに引けない = その繋ぎが後から消された。別物なので書き分ける */}
                          {step.viaTransitionId
                            ? "この繋ぎは記録から消えています"
                            : "記録に無い繋ぎ（「曲を変える」で移りました）"}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ul>
      )}

      <p className="label mt-6">
        新しいセットが上 · セットの中はかけた順 · 残るのはこの端末の中だけです（最大50セット）
      </p>
    </main>
  );
}
