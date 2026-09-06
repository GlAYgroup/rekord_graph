"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CueLine } from "./CuePad";
import { usePerformance } from "./PerformanceMode";
import { TempoBadge } from "./TempoBadge";
import { TrackTimeline } from "./TrackTimeline";
import { barsLabel, bpmDelta, cueLabel } from "@/lib/format";
import { maxOnwardFrom } from "@/lib/route";
import type { Cue, Track, Transition } from "@/lib/types";

/**
 * プレイ画面 = **今かけている曲から、次に繋げる先を1タップで辿っていく画面。**
 *
 * 見るのはプレイ中のスマホなので、置くものを絞る:
 *  - 左上に「今かけている曲」。ここが常に基準
 *  - その下に、そこから繋げる先が全部。どのキューからどのキューへ・どう繋ぐか（メモ）を
 *    **省略せずに**出す。DJ 中に読めない情報は無いのと同じ
 *  - 右側に行き先の曲名チップ。押すとその曲が「今かけている曲」になって、また一覧が入れ替わる
 *
 * ★ 本番（パフォーマンスモード）中は「一度かけた曲」を使い切りにする。
 *   1セットの中で同じ曲は2回かけないので、使った曲へ入る繋ぎは一覧から消え、
 *   「この先最大◯曲」も**残っている曲だけで**数え直す（`maxOnwardFrom`）。
 *   本番でないときは下見なので何も消さない（使った曲には印だけ付ける）。
 *
 * モードは画面ごとに作らず、ナビの「本番」（`usePerformance`）をそのまま使う。
 * 「今この端末が本番中か」という同じ問いに答えが2つある状態を作らない。
 */

const STORAGE = "rg.play.v1";

/** 端末に残す。リロードやアプリの切り替えでセットの途中が消えると困る */
const readStored = (): string[] => {
  try {
    const raw = localStorage.getItem(STORAGE);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch { return []; }
};

export function PlayDeck({
  tracks, cues, transitions, maxFrom, initialTrackId,
}: {
  tracks: Track[];
  cues: Cue[];
  transitions: Transition[];
  /** 全曲を使える前提の「この先最大◯曲」。本番中に使った曲を外した数は端末で数え直す */
  maxFrom: Record<string, number>;
  initialTrackId: string | null;
}) {
  const { on: performing } = usePerformance();

  /** かけてきた順。最後が「今かけている曲」 */
  const [path, setPath] = useState<string[]>(initialTrackId ? [initialTrackId] : []);
  /** 端末に残した続きを読むのは mount 後（サーバの描画と食い違わせない） */
  const [restored, setRestored] = useState(false);

  const trackById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);
  const cuesByTrack = useMemo(() => {
    const m = new Map<string, Cue[]>();
    for (const c of cues) {
      const list = m.get(c.trackId) ?? [];
      list.push(c);
      m.set(c.trackId, list);
    }
    return m;
  }, [cues]);
  const outgoing = useMemo(() => {
    const m = new Map<string, Transition[]>();
    for (const t of transitions) {
      const list = m.get(t.fromTrackId) ?? [];
      list.push(t);
      m.set(t.fromTrackId, list);
    }
    return m;
  }, [transitions]);

  useEffect(() => {
    if (restored) return;
    setRestored(true);
    if (initialTrackId) {
      // 曲を指定して来た人が優先。ただし指定は URL から外す
      // （セットの途中で再読み込みしたときに、また最初の曲へ戻されないように）
      window.history.replaceState(null, "", "/play");
      return;
    }
    const stored = readStored().filter((id) => trackById.has(id));
    if (stored.length) setPath(stored);
  }, [restored, initialTrackId, trackById]);

  useEffect(() => {
    if (!restored) return;
    try { localStorage.setItem(STORAGE, JSON.stringify(path)); } catch { /* 使えなければ残さない */ }
  }, [path, restored]);

  const currentId = path[path.length - 1] ?? null;
  const current = currentId ? trackById.get(currentId) : undefined;
  /** すでにかけた曲（今の曲を含む）。本番中はここへ入る繋ぎを使わない */
  const used = useMemo(() => new Set(path), [path]);

  /** 今の曲から出ている繋ぎ。テンポが近い順 = ピッチを触らずに済むものから */
  const candidates = useMemo(() => {
    if (!current) return [];
    return [...(outgoing.get(current.id) ?? [])].sort(
      (a, b) =>
        Math.abs(bpmDelta(current.bpm, trackById.get(a.toTrackId)?.bpm ?? null) ?? 999) -
        Math.abs(bpmDelta(current.bpm, trackById.get(b.toTrackId)?.bpm ?? null) ?? 999),
    );
  }, [current, outgoing, trackById]);

  const open = performing ? candidates.filter((t) => !used.has(t.toTrackId)) : candidates;
  const hidden = candidates.length - open.length;

  /**
   * 「この先最大◯曲」。本番中は使った曲を外して数え直す。
   * 一覧の並びぶんだけ探索が走るので、今の曲と使った曲が変わるまで使い回す。
   */
  const onward = useMemo(() => {
    const m: Record<string, { count: number; truncated: boolean }> = {};
    for (const t of open) {
      m[t.id] = performing
        ? maxOnwardFrom(outgoing, t.toTrackId, used)
        : { count: maxFrom[t.toTrackId] ?? 1, truncated: false };
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open.map((t) => t.id).join(","), performing, used, outgoing, maxFrom]);

  /** 今の曲から先、あと何曲つなげるか（今の曲を含む） */
  const remaining = current
    ? performing
      ? maxOnwardFrom(outgoing, current.id, new Set([...used].filter((id) => id !== current.id))).count
      : maxFrom[current.id] ?? 1
    : 0;

  if (!current) {
    return (
      <StartPicker
        tracks={tracks}
        maxFrom={maxFrom}
        onPick={(id) => setPath([id])}
      />
    );
  }

  return (
    <main className="relative z-1 mx-auto max-w-4xl px-3 pb-nav sm:px-4">
      {/* ── 今かけている曲。ここが常に基準なので上に貼り付けておく ── */}
      <header className="sticky top-0 z-20 -mx-3 border-b border-border bg-bg/90 px-3 pb-3 pt-3 backdrop-blur-md sm:-mx-4 sm:px-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <span className="label">{performing ? "本番 · 今かけている曲" : "今かけている曲"}</span>
            <div
              className="mt-1 inline-flex max-w-full flex-wrap items-center gap-2 rounded-full border border-hot/50 bg-hot/12 px-3.5 py-1.5"
            >
              <span className="min-w-0 break-words text-[17px] font-bold leading-tight text-hot">
                {current.name}
              </span>
              <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-hot/80">
                {current.bpm ?? "–"}{current.musicalKey && ` ${current.musicalKey}`}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            {path.length > 1 && (
              <button
                onClick={() => setPath((p) => p.slice(0, -1))}
                className="tap rounded-full border border-border bg-surface px-3 text-[12.5px] text-fg-muted hover:text-fg"
              >
                戻す
              </button>
            )}
            <button
              onClick={() => setPath([])}
              className="tap rounded-full border border-border bg-surface px-3 text-[12.5px] text-fg-subtle hover:text-fg"
            >
              曲を変える
            </button>
          </div>
        </div>

        {/* かけてきた順。押すとそこまで戻れる = 押し間違えても1タップで直せる */}
        {path.length > 1 && (
          <nav className="mt-2 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-[12px] text-fg-subtle">
            {path.slice(0, -1).map((id, i) => (
              <span key={`${id}-${i}`} className="shrink-0">
                {i > 0 && <span className="mx-1">→</span>}
                <button onClick={() => setPath(path.slice(0, i + 1))} className="hover:text-fg-muted">
                  {trackById.get(id)?.name ?? "?"}
                </button>
              </span>
            ))}
            <span className="mx-1 shrink-0">→</span>
            <span className="shrink-0 text-fg-muted">今</span>
          </nav>
        )}

        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[12px] text-fg-subtle">
          <span>かけた {path.length}曲</span>
          <span className={remaining > 1 ? "text-hot" : ""}>
            {remaining > 1 ? `この先 最大${remaining}曲` : "行き止まり"}
          </span>
          {performing && hidden > 0 && <span>使用済みで隠した繋ぎ {hidden}</span>}
          {!performing && (
            <span className="text-fg-subtle">
              下見中（本番にすると、かけた曲が一覧から消えます）
            </span>
          )}
        </p>
      </header>

      {open.length === 0 ? (
        <p className="mt-8 rounded-card border border-border bg-surface p-5 text-[14px] text-fg-muted">
          {candidates.length === 0
            ? "この曲から繋げる先はまだ記録されていません。"
            : "繋げる先はありますが、どれも今回かけ終わった曲です。"}
          <br />
          「戻す」で一つ前に戻るか、「曲を変える」で別の曲から始められます。
        </p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {open.map((t) => {
            const to = trackById.get(t.toTrackId);
            const fromCue = cueById.get(t.fromCueId);
            const toCue = cueById.get(t.toCueId);
            const n = onward[t.id];
            return (
              <li key={t.id}>
                <button
                  onClick={() => setPath((p) => [...p, t.toTrackId])}
                  className="flex w-full gap-3 rounded-card border border-border bg-linear-to-b from-surface to-surface-2 p-3 text-left transition-colors hover:border-border-bright active:border-hot/60 sm:gap-4 sm:p-4"
                  style={{ boxShadow: "var(--shadow-card)" }}
                >
                  {/* ── 左: どのキューからどのキューへ・どう繋ぐか（全文） ── */}
                  <div className="min-w-0 flex-1 space-y-2">
                    <CueLine cue={fromCue} size="sm" />
                    <TrackTimeline
                      durationSec={current.durationSec}
                      cues={cuesByTrack.get(current.id) ?? []}
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

                    {(t.technique || t.bars != null || t.comment) && (
                      <div className="space-y-1 pt-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          {t.technique && (
                            <span className="rounded border border-border-bright bg-elevated px-1.5 py-0.5 text-[11px] text-fg">
                              {t.technique}
                            </span>
                          )}
                          {t.bars != null && (
                            <span className="text-[11.5px] tabular-nums text-fg-subtle">
                              {barsLabel(t.bars, cueLabel(toCue))}
                            </span>
                          )}
                        </div>
                        {/* メモは**省略しない**。改行もそのまま出す（プレイ中に読む本文） */}
                        {t.comment && (
                          <p className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-fg">
                            {t.comment}
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ── 右: 行き先の曲名チップ。押す対象はカード全体だが、目印はここ ── */}
                  <div className="flex w-[112px] shrink-0 flex-col items-end gap-1.5 sm:w-[190px]">
                    <span className="w-full rounded-card border border-accent/45 bg-accent/10 px-2.5 py-1.5 text-right text-[13.5px] font-semibold leading-snug break-words text-accent sm:text-[15px]">
                      {to?.name ?? "不明な曲"}
                    </span>
                    <span className="font-mono text-[11px] tabular-nums text-fg-subtle">
                      {to?.bpm ?? "–"} {to?.musicalKey}
                    </span>
                    <TempoBadge from={current.bpm} to={to?.bpm ?? null} />
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] tabular-nums ${
                        (n?.count ?? 1) > 1
                          ? "border-hot/35 bg-hot/10 text-hot"
                          : "border-border text-fg-subtle"
                      }`}
                      title={
                        performing
                          ? "まだかけていない曲だけで数えた「この先つなげる曲数」"
                          : "全曲を使える前提で数えた「この先つなげる曲数」"
                      }
                    >
                      {/* 打ち切ったときの数は下限なので「以上」と断る（多い方に嘘をつかない） */}
                      {(n?.count ?? 1) > 1
                        ? `この先${n?.count}曲${n?.truncated ? "以上" : ""}`
                        : "行き止まり"}
                    </span>
                    {t.practice && (
                      <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10.5px] text-warn">
                        要練習
                      </span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <p className="label mt-4">
        タップすると、その曲が「今かけている曲」になります
      </p>
    </main>
  );
}

/** 最初の1曲を選ぶ。曲名・別名・原題のどれでも引っかかる（一覧画面と同じ数え方） */
function StartPicker({
  tracks, maxFrom, onPick,
}: {
  tracks: Track[];
  maxFrom: Record<string, number>;
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    return tracks
      .filter((t) => {
        const hay = `${t.name} ${t.alias} ${t.fullTitle}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => (maxFrom[b.id] ?? 1) - (maxFrom[a.id] ?? 1) || a.name.localeCompare(b.name, "ja"));
  }, [q, tracks, maxFrom]);

  return (
    <main className="relative z-1 mx-auto max-w-2xl px-4 pb-nav pt-4">
      <h1 className="text-[22px] font-bold tracking-tight">最初にかける曲</h1>
      <p className="mt-1 text-[13px] text-fg-muted">
        選ぶとここから繋げる先が並びます。長くつなげる曲が上です。
      </p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="曲を検索（別名でも可）"
        inputMode="search"
        autoComplete="off"
        className="mt-3 h-12 w-full rounded-card border border-border bg-surface px-4 text-[16px] outline-none placeholder:text-fg-subtle focus:border-accent"
      />
      <ul className="mt-3 space-y-1.5">
        {shown.map((t) => (
          <li key={t.id}>
            <button
              onClick={() => onPick(t.id)}
              className="tap flex w-full items-center gap-2 rounded-card border border-border bg-surface px-3.5 text-left transition-colors hover:border-border-bright"
            >
              <span className="min-w-0 flex-1 break-words text-[15px]">{t.name}</span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                {t.bpm ?? "–"} {t.musicalKey}
              </span>
              <span
                className={`shrink-0 font-mono text-[11px] tabular-nums ${
                  (maxFrom[t.id] ?? 1) > 1 ? "text-hot" : "text-fg-subtle"
                }`}
              >
                {(maxFrom[t.id] ?? 1) > 1 ? `最大${maxFrom[t.id]}曲` : "行き止まり"}
              </span>
            </button>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="px-1 py-3 text-[13px] text-fg-subtle">見つかりません</li>
        )}
      </ul>
      <p className="label mt-4">
        <Link href="/" className="hover:text-fg-muted">一覧に戻る</Link>
      </p>
    </main>
  );
}
