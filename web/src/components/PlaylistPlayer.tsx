"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { HopDetails } from "./HopDetails";
import { usePerformance } from "./PerformanceMode";
import { TempoBadge } from "./TempoBadge";
import { alignHops, type Playlist } from "@/lib/playlist";
import type { Cue, Track, Transition } from "@/lib/types";
import { usePlaylistPos } from "@/lib/usePlaylistPos";

/**
 * プレイリストのプレイ画面。**決めた順を1曲ずつたどるだけ**の画面で、/play のように
 * 行ける繋ぎを全部は並べない（イベント用に組んだ流れを、そのまま本番で読むため）。
 *
 * - 上に「今かけている曲」と何曲目か。その下に**このプレイリストの次の繋ぎ1本**を全文で
 *   （`HopDetails`。/play のカードと同じ中身。キュー名もメモも省略しない）
 * - 「次の曲へ」で1曲進む、「前の曲へ」で1曲戻る。何曲目かは端末に残る（`usePlaylistPos`）
 * - 間に繋ぎが記録されていないところは、そう言ったうえで次の曲名だけを出す（進めはする）
 * - 一番下に流れ全体（かけた曲は薄く、今と次を強く）
 * - 最初に戻すのは2タップ（暗いブースで誤爆してもセットが消えないように）
 * Notion には何も書かない（`data-edit` の付くものは無い）。
 */
export function PlaylistPlayer({
  playlist, tracks, cues, transitions,
}: {
  playlist: Playlist;
  tracks: Track[];
  cues: Cue[];
  transitions: Transition[];
}) {
  const { on: performing } = usePerformance();
  const byRb = useMemo(() => new Map(tracks.map((t) => [t.rekordboxId, t])), [tracks]);
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);
  const transitionById = useMemo(() => new Map(transitions.map((t) => [t.id, t])), [transitions]);
  const cuesByTrack = useMemo(() => {
    const m = new Map<string, Cue[]>();
    for (const c of cues) (m.get(c.trackId) ?? m.set(c.trackId, []).get(c.trackId)!).push(c);
    return m;
  }, [cues]);
  const items = playlist.trackRbIds;
  const trackIds = useMemo(() => items.map((rb) => byRb.get(rb)?.id ?? `rb:${rb}`), [items, byRb]);
  // 保存後に繋ぎが消えた・足されたときも、今ある繋ぎで揃え直して読む（編集画面と同じ）
  const hops = useMemo(() => alignHops(trackIds, playlist.hops, transitions), [trackIds, playlist.hops, transitions]);

  const [stored, setPos] = usePlaylistPos(playlist.id);
  const last = Math.max(0, items.length - 1);
  const pos = Math.min(stored, last); // 曲が減っていたら最後の曲に留める
  const [confirmRestart, setConfirmRestart] = useState(false);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [pos]);

  const current = byRb.get(items[pos] ?? "");
  const next = pos < last ? byRb.get(items[pos + 1]) : undefined;
  const hop = pos < last && hops[pos] ? transitionById.get(hops[pos]!) : undefined;
  const nameOf = (rb: string) => byRb.get(rb)?.name ?? `rekordbox に無い曲（${rb}）`;

  if (items.length === 0) {
    return (
      <main className="relative z-1 mx-auto max-w-2xl px-4 pb-nav pt-4">
        <p className="text-[14px] text-fg-muted">このプレイリストにはまだ曲がありません。</p>
        <Link href={`/playlists/${playlist.id}`} className="mt-3 inline-block text-[13px] text-accent">← 曲を並べる</Link>
      </main>
    );
  }

  return (
    <main className="relative z-1 mx-auto max-w-4xl px-3 pb-nav sm:px-4">
      {/* ── 今かけている曲 ── */}
      <header className="sticky top-0 z-20 -mx-3 border-b border-border bg-bg/90 px-3 pb-3 pt-3 backdrop-blur-md sm:-mx-4 sm:px-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <span className="label">
              {playlist.name} · {pos + 1}/{items.length}曲目{performing ? " · 本番" : ""}
            </span>
            <div className="mt-1 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-card border border-hot/50 bg-hot/12 px-3.5 py-1.5">
              <span className="min-w-0 break-words text-[17px] font-bold leading-tight text-hot">
                {nameOf(items[pos])}
              </span>
              {current && (
                <span className="shrink-0 whitespace-nowrap font-mono text-[11.5px] tabular-nums text-hot/80">
                  {current.bpm ?? "–"}{current.musicalKey && ` ${current.musicalKey}`}
                </span>
              )}
            </div>
          </div>
          <Link
            href={`/playlists/${playlist.id}`}
            className="tap shrink-0 rounded-full border border-border bg-surface px-3 text-[12.5px] text-fg-subtle hover:text-fg"
          >
            並びを見る
          </Link>
        </div>
      </header>

      {/* ── 次の繋ぎ（このプレイリストの1本だけ） ── */}
      {pos < last ? (
        <section
          className="mt-3 rounded-card border border-border bg-linear-to-b from-surface to-surface-2 p-3 sm:p-4"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="label">次の曲 · {pos + 2}曲目</span>
            <span className="min-w-0 basis-full rounded-card border border-accent/45 bg-accent/10 px-2.5 py-1.5 text-[15px] font-semibold leading-snug break-words text-accent">
              {nameOf(items[pos + 1])}
            </span>
            <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-fg-subtle">
              {next?.bpm ?? "–"} {next?.musicalKey}
            </span>
            <TempoBadge from={current?.bpm ?? null} to={next?.bpm ?? null} />
          </div>
          <div className="mt-3">
            {hop ? (
              <HopDetails
                t={hop}
                from={current}
                to={next}
                cueById={cueById}
                cuesByTrack={cuesByTrack}
                showRating
              />
            ) : (
              <p className="text-[14px] text-warn">この2曲の間の繋ぎは記録されていません。</p>
            )}
          </div>
        </section>
      ) : (
        <p className="mt-4 rounded-card border border-border bg-surface p-4 text-[14px] text-fg-muted">
          最後の曲です。お疲れさまでした。
        </p>
      )}

      {/* ── 進む・戻る ── */}
      <div className="mt-3 flex gap-2">
        {pos > 0 && (
          <button
            onClick={() => { setConfirmRestart(false); setPos(pos - 1); }}
            className="tap rounded-card border border-border bg-surface px-4 text-[13.5px] text-fg-muted hover:text-fg"
          >
            ← 前の曲へ
          </button>
        )}
        {pos < last && (
          <button
            onClick={() => { setConfirmRestart(false); setPos(pos + 1); }}
            className="tap flex-1 rounded-card border border-hot/50 bg-hot/12 px-4 py-3 text-[15px] font-semibold text-hot"
          >
            次の曲へ →
          </button>
        )}
      </div>

      {/* ── 流れ全体 ── */}
      <section className="mt-6">
        <span className="label">このプレイリストの流れ</span>
        <ol className="mt-2 space-y-0.5">
          {items.map((rb, i) => (
            <li
              key={`${rb}-${i}`}
              className={`flex items-baseline gap-2 rounded px-1.5 py-1 ${
                i === pos ? "bg-hot/12" : i === pos + 1 ? "bg-accent/8" : ""
              }`}
            >
              <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-subtle">{i + 1}</span>
              <span
                className={`min-w-0 flex-1 break-words text-[14px] ${
                  i < pos ? "text-fg-subtle" : i === pos ? "font-semibold text-hot" : i === pos + 1 ? "text-accent" : "text-fg"
                }`}
              >
                {nameOf(rb)}
              </span>
              {i < last && !hops[i] && <span className="shrink-0 text-[11px] text-warn">次へ繋ぎなし</span>}
            </li>
          ))}
        </ol>
      </section>

      {/* ── 最初に戻す（2タップ） ── */}
      {pos > 0 && (
        <div className="mt-6 border-t border-border pt-3">
          {confirmRestart ? (
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-warn">1曲目に戻しますか？</span>
              <button onClick={() => { setConfirmRestart(false); setPos(0); }} className="tap rounded-full border border-warn/50 px-3 text-warn">戻す</button>
              <button onClick={() => setConfirmRestart(false)} className="tap rounded-full border border-border px-3 text-fg-muted">やめる</button>
            </div>
          ) : (
            <button onClick={() => setConfirmRestart(true)} className="tap text-[12.5px] text-fg-subtle hover:text-fg">
              最初に戻す
            </button>
          )}
        </div>
      )}
    </main>
  );
}
