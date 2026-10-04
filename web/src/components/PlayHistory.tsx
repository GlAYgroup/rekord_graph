"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { SaveAsPlaylist } from "./SaveAsPlaylist";
import { barsLabel, cueLabel, cueOf } from "@/lib/format";
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
 *
 * 書く口が2つある（どちらも Notion に書くので `data-edit` = 本番中は畳む）:
 *  - 「曲を変える」で移った所の「この繋ぎを記録」… `/new?from=&to=` を2曲埋めて開く。
 *    本番で急に繋いだものを、後から記録に起こす入口
 *  - セットごとの「プレイリストとして保存」… `SaveAsPlaylist`。記録に無い間・消えた繋ぎは null で送る
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
      <div className="pr-corner flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-[22px] font-bold tracking-tight">プレイ履歴</h1>
        <Link
          href="/play"
          className="btn"
        >
          プレイへ
        </Link>
      </div>
      <p className="mt-1 text-[13px] text-fg-muted">
        リセットしたセットの繋ぎ方が、この端末に残ります。
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
                        className="btn btn-warn"
                      >
                        消す
                      </button>
                      <button
                        onClick={() => setConfirmId(null)}
                        className="btn"
                      >
                        やめる
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmId(set.id)}
                      className="btn"
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
                  const toCueLabel = via ? cueLabel(cueOf(cueById, via.toCueId)) : "";
                  return (
                    <li key={`${set.id}-${i}`} className="px-4 py-2.5">
                      <div className="flex items-baseline gap-2 text-[14.5px]">
                        <span className="shrink-0 font-mono text-[12px] tabular-nums text-fg-subtle">
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
                          <span className="font-mono text-[12px] break-words text-fg-subtle">
                            {cueLabel(cueOf(cueById, via.fromCueId))} → {toCueLabel}
                          </span>
                          {(via.technique || barsLabel(via, toCueLabel)) && (
                            <span className="ml-2 text-[12px] text-fg-muted">
                              {via.technique}
                              {via.technique && barsLabel(via, toCueLabel) && " · "}
                              {barsLabel(via, toCueLabel)}
                            </span>
                          )}
                        </div>
                      ) : (
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-[18px] text-[12px] text-fg-subtle">
                          {/* 繋ぎ ID が無い = その場で別の曲へ移った。
                              ID はあるのに引けない = その繋ぎが後から消された。別物なので書き分ける */}
                          <span>
                            {step.viaTransitionId
                              ? "この繋ぎは記録から消えています"
                              : "記録に無い繋ぎ（「曲を変える」で移りました）"}
                          </span>
                          {/* その場で繋いだものを記録に起こす入口。2曲とも一覧にあるときだけ（無い曲は入力画面で選べない） */}
                          {!step.viaTransitionId && from && to && (
                            <Link
                              data-edit
                              href={`/new?from=${fromId}&to=${step.trackId}`}
                              className="btn px-2.5 text-[12px]"
                            >
                              この繋ぎを記録
                            </Link>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>

              {/*
                このセットをイベントのプレイリストとして残す。間の繋ぎは押した繋ぎそのもの（ID）。
                記録に無い間（「曲を変える」）・後から消えた繋ぎは null（API もプレイリストも「繋ぎなし」として持つ）。
                記録に無い間・消えた繋ぎは null で渡す（プレイリストでは繋ぎ無しになる）。
                曲一覧に無い曲が混ざると rekordbox の ID が引けないので、ボタンは押せない
              */}
              <div data-edit className="border-t border-border px-4 pb-3 pt-1">
                <SaveAsPlaylist
                  trackIds={set.steps.map((s) => s.trackId)}
                  edges={set.steps.slice(1).map((s) =>
                    (s.viaTransitionId && transitionById.get(s.viaTransitionId)) || null,
                  )}
                  trackById={trackById}
                  defaultName={`${new Date(set.endedAt).toLocaleDateString("ja-JP")} のセット`}
                />
              </div>
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
