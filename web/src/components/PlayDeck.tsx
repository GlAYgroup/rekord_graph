"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { CueLine } from "./CuePad";
import { usePerformance } from "./PerformanceMode";
import { TempoBadge } from "./TempoBadge";
import { TrackTimeline } from "./TrackTimeline";
import { barsLabel, bpmDelta, cueLabel } from "@/lib/format";
import { archive, readCurrent, writeCurrent, type PlayStep } from "@/lib/playlog";
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
 * ★ 本番では「記録に無い曲」へ急に繋ぐことがある。そのときのための入口が「曲を変える」で、
 *   これは**かけてきた順を捨てずに、選んだ曲を後ろに足す**（＝繋いだ曲として数える）。
 *   一覧には繋ぎが1本も無い曲も並ぶので、そこへも移れる。
 *   セットを最初から取り直したいときだけ「リセット」。**この2つは別物なので分けてある**
 *   （今までの「曲を変える」は全部消していた ＝ 本番中に押すと戻れなかった）。
 *
 * モードは画面ごとに作らず、ナビの「本番」（`usePerformance`）をそのまま使う。
 * 「今この端末が本番中か」という同じ問いに答えが2つある状態を作らない。
 *
 * 「戻す」「曲を変える」「リセット」は Notion に何も書かないので `data-edit` を付けない。
 * 本番中に畳んでしまうと、急な差し替えから戻る道が無くなる。
 *
 * ★ セットが終わる（リセット / 別の曲から開き直す）と、**かけてきた順は履歴として端末に残る**
 *   （`lib/playlog.ts`。一覧は `/play/history`）。そのため1手ごとに「押した繋ぎの ID」も
 *   一緒に持つ — 同じ2曲の間に繋ぎが複数あることがあり、後から曲の組ではひき直せない。
 */

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

  /** かけてきた順。最後が「今かけている曲」。1手 = 曲 + そこへ入るのに使った繋ぎ */
  const [steps, setSteps] = useState<PlayStep[]>(
    initialTrackId ? [{ trackId: initialTrackId, viaTransitionId: null }] : [],
  );
  const path = useMemo(() => steps.map((s) => s.trackId), [steps]);
  /** 端末に残した続きを読むのは mount 後（サーバの描画と食い違わせない） */
  const [restored, setRestored] = useState(false);
  /**
   * 「最初の1回だけ」の見張りは state ではなく ref。
   * `setRestored(true)` は次の描画まで効かないので、effect が2回走る場面（開発時の
   * StrictMode など）では state だと素通りする = 履歴に同じセットが2つ積まれる
   */
  const initRef = useRef(false);
  /** 曲一覧を開いているか（＝繋ぎに無い曲へ移る途中）。かけてきた順はそのまま */
  const [picking, setPicking] = useState(false);
  /** リセットは2タップ。暗所で片手でも誤爆しないように、押してから確かめる */
  const [confirmReset, setConfirmReset] = useState(false);

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
    if (initRef.current) return;
    initRef.current = true;
    setRestored(true);
    if (initialTrackId) {
      // 曲を指定して来た人が優先。ただし指定は URL から外す
      // （セットの途中で再読み込みしたときに、また最初の曲へ戻されないように）
      // 途中だったセットはここで終わる = 捨てずに履歴へ残す
      archive(readCurrent().filter((s) => trackById.has(s.trackId)));
      window.history.replaceState(null, "", "/play");
      return;
    }
    const stored = readCurrent().filter((s) => trackById.has(s.trackId));
    if (stored.length) setSteps(stored);
  }, [initialTrackId, trackById]);

  useEffect(() => {
    if (!restored) return;
    writeCurrent(steps);
  }, [steps, restored]);

  // 一覧と行き先カードは別の長さの画面なのに、切り替えても縦位置は残る。
  // 3枚目まで送ってから「曲を変える」を押すと、84曲の一覧の途中（検索欄も「やめる」も
  // 画面の外）から始まってしまうので、開くときと閉じるときだけ上に戻す
  useEffect(() => { window.scrollTo({ top: 0 }); }, [picking]);

  const currentId = path[path.length - 1] ?? null;
  const current = currentId ? trackById.get(currentId) : undefined;
  /** すでにかけた曲（今の曲を含む）。本番中はここへ入る繋ぎを使わない */
  const used = useMemo(() => new Set(path), [path]);

  const candidates = useMemo(
    () => (current ? outgoing.get(current.id) ?? [] : []),
    [current, outgoing],
  );
  const open = performing ? candidates.filter((t) => !used.has(t.toTrackId)) : candidates;
  const hidden = candidates.length - open.length;

  /**
   * 一覧の並び = **「この先◯曲」が多い順。** 先が長い枝ほど、その後のセットの
   * 選択肢が残る。**先の長さは本番中に減っていく**（かけた曲を外して数え直すため）ので、
   * この並びも1タップごとに入れ替わる。
   *
   * 同数のときはテンポが近い順 = ピッチを触らずに済むものから。それも同じなら
   * 曲名・ID の順（同じ状況で毎回同じ並びになるように）。
   *
   * 「この先◯曲」の探索は一覧の数だけ走るので、今の曲と使った曲が変わるまで使い回す。
   */
  const rows = useMemo(() => {
    if (!current) return [];
    const list = open.map((t) => {
      const to = trackById.get(t.toTrackId);
      return {
        transition: t,
        to,
        onward: performing
          ? maxOnwardFrom(outgoing, t.toTrackId, used)
          : { count: maxFrom[t.toTrackId] ?? 1, truncated: false },
        tempo: Math.abs(bpmDelta(current.bpm, to?.bpm ?? null) ?? 999),
      };
    });
    list.sort(
      (a, b) =>
        b.onward.count - a.onward.count ||
        a.tempo - b.tempo ||
        (a.to?.name ?? "").localeCompare(b.to?.name ?? "", "ja") ||
        a.transition.id.localeCompare(b.transition.id),
    );
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, open.map((t) => t.id).join(","), performing, used, outgoing, maxFrom, trackById]);

  /** 今の曲から先、あと何曲つなげるか（今の曲を含む） */
  const remaining = current
    ? performing
      ? maxOnwardFrom(outgoing, current.id, new Set([...used].filter((id) => id !== current.id))).count
      : maxFrom[current.id] ?? 1
    : 0;

  // 曲が決まっていない（＝最初の1曲）と、途中で別の曲へ移るときは同じ一覧を出す。
  // 違うのは選んだ結果だけ: 前者は「そこから始める」、後者は「後ろに足す」
  if (!current || picking) {
    return (
      <StartPicker
        tracks={tracks}
        maxFrom={maxFrom}
        used={used}
        mode={current ? "jump" : "start"}
        onPick={(id) => {
          setPicking(false);
          // 記録に無い繋ぎで移ったときは繋ぎ ID を残さない（履歴でもそう出す）
          setSteps((p) =>
            current
              ? [...p, { trackId: id, viaTransitionId: null }]
              : [{ trackId: id, viaTransitionId: null }],
          );
        }}
        onCancel={current ? () => setPicking(false) : null}
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
                onClick={() => setSteps((p) => p.slice(0, -1))}
                className="tap rounded-full border border-border bg-surface px-3 text-[12.5px] text-fg-muted hover:text-fg"
              >
                戻す
              </button>
            )}
            <button
              onClick={() => { setConfirmReset(false); setPicking(true); }}
              className="tap rounded-full border border-border bg-surface px-3 text-[12.5px] text-fg-subtle hover:text-fg"
              title="記録に無い曲へも移れます。かけてきた順はそのまま残ります"
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
                <button onClick={() => setSteps(steps.slice(0, i + 1))} className="hover:text-fg-muted">
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

      {rows.length === 0 ? (
        <p className="mt-8 rounded-card border border-border bg-surface p-5 text-[14px] text-fg-muted">
          {candidates.length === 0
            ? "この曲から繋げる先はまだ記録されていません。"
            : "繋げる先はありますが、どれも今回かけ終わった曲です。"}
          <br />
          「戻す」で一つ前に戻るか、「曲を変える」で記録に無い曲へも移れます
          （移った先も、繋いだ曲として数えます）。
        </p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {rows.map(({ transition: t, to, onward: n }) => {
            const fromCue = cueById.get(t.fromCueId);
            const toCue = cueById.get(t.toCueId);
            return (
              <li key={t.id}>
                <button
                  onClick={() => setSteps((p) => [...p, { trackId: t.toTrackId, viaTransitionId: t.id }])}
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

                    {(t.technique || barsLabel(t, cueLabel(toCue)) || t.comment) && (
                      <div className="space-y-1 pt-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          {t.technique && (
                            <span className="rounded border border-border-bright bg-elevated px-1.5 py-0.5 text-[11px] text-fg">
                              {t.technique}
                            </span>
                          )}
                          {barsLabel(t, cueLabel(toCue)) && (
                            <span className="text-[11.5px] tabular-nums text-fg-subtle">
                              {barsLabel(t, cueLabel(toCue))}
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
                        n.count > 1
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
                      {n.count > 1
                        ? `この先${n.count}曲${n.truncated ? "以上" : ""}`
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
        この先つなげる曲数が多い順 · タップすると、その曲が「今かけている曲」になります
      </p>

      {/*
        リセット = かけてきた順を一区切りにして、最初の1曲から選び直す。
        **一番下に置き、2タップにする。** 「戻す」「曲を変える」の隣に同じ大きさで置くと、
        暗いブースで押し間違えたときにセットが終わってしまう。
        押した分は消さずに履歴へ積む（`archive`）ので、後から `/play/history` で読み返せる
      */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2 border-t border-border pt-4">
        {confirmReset ? (
          <>
            <span className="text-[12.5px] text-fg-muted">
              かけた{path.length}曲を履歴に残して、最初から選び直します
            </span>
            <button
              onClick={() => { setConfirmReset(false); archive(steps); setSteps([]); }}
              className="tap rounded-full border border-warn/50 bg-warn/10 px-4 text-[12.5px] text-warn"
            >
              リセットする
            </button>
            <button
              onClick={() => setConfirmReset(false)}
              className="tap rounded-full border border-border px-3 text-[12.5px] text-fg-subtle hover:text-fg"
            >
              やめる
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setConfirmReset(true)}
              className="tap rounded-full border border-border px-4 text-[12.5px] text-fg-subtle hover:text-fg"
              title="ここまでを履歴に残して、最初の1曲から選び直す"
            >
              リセット
            </button>
            <Link
              href="/play/history"
              className="tap rounded-full border border-border px-4 text-[12.5px] text-fg-subtle hover:text-fg"
            >
              履歴
            </Link>
          </>
        )}
      </div>
    </main>
  );
}

/**
 * 曲を選ぶ一覧。**繋ぎが1本も無い曲も含めて全曲が並ぶ**（`mode="jump"` の存在意義がこれ）。
 * 曲名・別名・原題のどれでも引っかかる（一覧画面と同じ数え方）。
 *
 * 並べ替えに使うのは `maxFrom`（サーバで計算済み）だけ。ここで本番用に数え直すと
 * 全曲ぶんの探索が1文字打つたびに走るので、一覧では使わない。
 */
function StartPicker({
  tracks, maxFrom, used, mode, onPick, onCancel,
}: {
  tracks: Track[];
  maxFrom: Record<string, number>;
  /** すでにかけた曲。外しはしないが、印を付けて後ろに回す */
  used: ReadonlySet<string>;
  mode: "start" | "jump";
  onPick: (id: string) => void;
  /** 途中で開いたときだけ「やめる」で戻れる（かけてきた順は消さない） */
  onCancel: (() => void) | null;
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
      .sort(
        (a, b) =>
          Number(used.has(a.id)) - Number(used.has(b.id)) ||
          (maxFrom[b.id] ?? 1) - (maxFrom[a.id] ?? 1) ||
          a.name.localeCompare(b.name, "ja"),
      );
  }, [q, tracks, maxFrom, used]);

  return (
    <main className="relative z-1 mx-auto max-w-2xl px-4 pb-nav pt-4">
      <div className="flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-[22px] font-bold tracking-tight">
          {mode === "jump" ? "次にかける曲" : "最初にかける曲"}
        </h1>
        {onCancel && (
          <button
            onClick={onCancel}
            className="tap shrink-0 rounded-full border border-border bg-surface px-3 text-[12.5px] text-fg-subtle hover:text-fg"
          >
            やめる
          </button>
        )}
      </div>
      <p className="mt-1 text-[13px] text-fg-muted">
        {mode === "jump"
          ? "繋ぎが記録されていない曲へも移れます。選ぶと、繋いだ曲として続きから並びます。"
          : "選ぶとここから繋げる先が並びます。長くつなげる曲が上です。"}
      </p>
      {/* リセットの直後に立つのがこの画面なので、**曲の一覧より上に**履歴の入口を置く
          （84曲の下に置くと、前のセットを見返したい人には届かない） */}
      {mode === "start" && (
        <Link
          href="/play/history"
          className="tap mt-3 flex items-center justify-center rounded-card border border-border bg-surface text-center text-[13px] text-fg-muted transition-colors hover:border-border-bright hover:text-fg"
        >
          前にかけたセットを見る →
        </Link>
      )}
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
              {/* 使い切りにする曲でも選べるようにはしておく（本番で戻すこともある）。印だけ付けて後ろへ */}
              {used.has(t.id) && (
                <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-fg-subtle">
                  かけた
                </span>
              )}
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
        {mode === "jump"
          ? "「やめる」で、今かけている曲の一覧へ戻ります"
          : <Link href="/" className="hover:text-fg-muted">一覧に戻る</Link>}
      </p>
    </main>
  );
}
