"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { CueLine } from "./CuePad";
import { usePerformance } from "./PerformanceMode";
import { PracticeToggle } from "./PracticeToggle";
import { TempoBadge } from "./TempoBadge";
import { TrackTimeline } from "./TrackTimeline";
import { barsLabel, bpmDelta, cueLabel } from "@/lib/format";
import { DIFFICULTIES, DIFFICULTY_LABEL, difficultyRank, type Difficulty } from "@/lib/difficulty";
import {
  archive, NO_FILTER, readCurrent, readFilter, writeCurrent, writeFilter,
  type PlayFilter, type PlayStep,
} from "@/lib/playlog";
import { RATINGS, starCount } from "@/lib/ratings";
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
 * ★ 「一度かけた曲」は使い切り。**本番でも下見でも同じ**（1つのプレイの中で同じ曲は
 *   2回出さない）。使った曲へ入る繋ぎは一覧から消え、「この先最大◯曲」も
 *   **残っている曲だけで**数え直す（`maxOnwardFrom`）。
 *   「同じ曲」は**リミックス違いも含む**（`Track.songId`）。`フォニイ（6Tan bootleg）` を
 *   かけたら、`フォニイ（KOHaq remix）` もそのセットでは出さない。
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
 *
 * ★ 除外条件（難易度「◯まで」・星「◯以上」）で繋ぎを外せる。外した繋ぎは**無いものとして**
 *   「この先◯曲」も数え直す（カードだけ隠すと、外した繋ぎを通った数と並びが残る）。
 *   未入力の繋ぎは外さない。条件は端末に残り、リセットしても消えない（`lib/playlog.ts`）。
 *   Notion に何も書かないので `data-edit` は付けない（本番中に緩められないと困る）。
 */

export function PlayDeck({
  tracks, cues, transitions, maxFrom, initialTrackId,
}: {
  tracks: Track[];
  cues: Cue[];
  transitions: Transition[];
  /**
   * 全曲を使える前提の「この先最大◯曲」。曲を選ぶ一覧の並びにだけ使う。
   * 繋ぎのカードに出す数は、かけた曲を外して端末で数え直す
   */
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
  /**
   * かけてきた順で押した曲（「本当に戻りますか？」を出している間だけ）。押した時点の曲数も控え、
   * その後に進んだり「戻す」を押したりしたら確認は取り下げる（ずれた位置で戻らせない）
   */
  const [confirmBack, setConfirmBack] = useState<{ index: number; length: number } | null>(null);
  /** 除外条件。端末に残したものを mount 後に読む */
  const [filter, setFilter] = useState<PlayFilter>(NO_FILTER);
  const [filterOpen, setFilterOpen] = useState(false);
  const filtering = filter.maxDifficulty !== null || filter.minStars > 0;

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
    setFilter(readFilter());
    /*
      「この曲から始める」は、**アドレスにまだ `?from=` が残っているとき**だけ。
      下で URL から外しても、Next は `?from=` で描いた画面データを履歴に持っている。
      「履歴」を開いてから戻ると、その古いデータ（initialTrackId 付き）でここが作り直され、
      途中まで来たセットが最初の1曲に巻き戻っていた（頼んでいないのに履歴へも積まれる。実際に起きた）
    */
    const fromInUrl = new URLSearchParams(window.location.search).get("from");
    if (initialTrackId && fromInUrl === initialTrackId) {
      // 曲を指定して来た人が優先。ただし指定は URL から外す
      // （セットの途中で再読み込みしたときに、また最初の曲へ戻されないように）
      // 途中だったセットはここで終わる = 捨てずに履歴へ残す
      archive(readCurrent().filter((s) => trackById.has(s.trackId)));
      window.history.replaceState(null, "", "/play");
      return;
    }
    // 端末に残した続きが正。空なら（リセット済みなど）古い指定の曲も使わず、最初の1曲から選ぶ
    setSteps(readCurrent().filter((s) => trackById.has(s.trackId)));
  }, [initialTrackId, trackById]);

  useEffect(() => {
    if (!restored) return;
    writeCurrent(steps);
  }, [steps, restored]);
  useEffect(() => {
    if (restored) writeFilter(filter);
  }, [filter, restored]);

  /**
   * 除外条件を通る繋ぎか。**未入力は通す**（難易度・星は後から付けていくもので、
   * 未入力を外すと条件を入れた途端にほとんどの繋ぎが消える）
   */
  const passes = useMemo(() => {
    const maxRank = difficultyRank(filter.maxDifficulty);
    return (t: Transition) => {
      const rank = difficultyRank(t.difficulty);
      if (maxRank > 0 && rank > maxRank) return false;
      const stars = starCount(t.rating);
      if (filter.minStars > 0 && stars > 0 && stars < filter.minStars) return false;
      return true;
    };
  }, [filter]);
  /** 条件で外した繋ぎを抜いた隣接。「この先◯曲」はこちらで数える */
  const usable = useMemo(() => {
    const m = new Map<string, Transition[]>();
    for (const [id, list] of outgoing) m.set(id, list.filter(passes));
    return m;
  }, [outgoing, passes]);

  // 一覧と行き先カードは別の長さの画面なのに、切り替えても縦位置は残る。
  // 3枚目まで送ってから「曲を変える」を押すと、84曲の一覧の途中（検索欄も「やめる」も
  // 画面の外）から始まってしまうので、開くときと閉じるときは上に戻す。
  // **今の曲が変わったとき**（カードで送る・戻す・リセット）も同じ: 下の方のカードで送ると、
  // 次の曲の一覧はいちばん先の長い候補（＝一番上）が画面の上に隠れたまま始まっていた
  const currentId = path[path.length - 1] ?? null;
  useEffect(() => { window.scrollTo({ top: 0 }); }, [picking, currentId]);
  const current = currentId ? trackById.get(currentId) : undefined;
  /** 曲ID -> 同じ曲の仲間で共通の ID。リミックス違いは同じ値 */
  const songOf = useMemo(
    () => (id: string) => trackById.get(id)?.songId ?? id,
    [trackById],
  );
  /**
   * すでにかけた曲（今の曲を含む）を **songId で**持つ。ここへ入る繋ぎは使わない。
   * 本番・下見どちらでも同じ（同じ曲がセットの中に2回出てこないように）
   */
  const usedSongs = useMemo(() => new Set(path.map(songOf)), [path, songOf]);

  const candidates = useMemo(
    () => (current ? outgoing.get(current.id) ?? [] : []),
    [current, outgoing],
  );
  const unplayed = candidates.filter((t) => !usedSongs.has(songOf(t.toTrackId)));
  const open = unplayed.filter(passes);
  /** かけた曲で隠した数と、条件で外した数は別の話なので分けて出す */
  const hiddenPlayed = candidates.length - unplayed.length;
  const hiddenFiltered = unplayed.length - open.length;

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
        onward: maxOnwardFrom(usable, songOf, t.toTrackId, usedSongs),
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
  }, [current, open.map((t) => t.id).join(","), usedSongs, usable, songOf, trackById]);

  /** 今の曲から先、あと何曲つなげるか（今の曲を含む）。今の曲の songId は起点なので外す */
  const remaining = current
    ? maxOnwardFrom(
        usable,
        songOf,
        current.id,
        new Set([...usedSongs].filter((s) => s !== songOf(current.id))),
      ).count
    : 0;

  // かけてきた順は右端（最新）を見せる。横スクロールの箱は左端から始まるので、
  // スマホでは2〜3曲で最新側と「→ 今」が画面の外に切れていた
  const crumbsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path]);

  // 曲が決まっていない（＝最初の1曲）と、途中で別の曲へ移るときは同じ一覧を出す。
  // 違うのは選んだ結果だけ: 前者は「そこから始める」、後者は「後ろに足す」
  if (!current || picking) {
    return (
      <StartPicker
        tracks={tracks}
        maxFrom={maxFrom}
        usedSongs={usedSongs}
        playedIds={new Set(path)}
        filtering={filtering}
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

  /** 戻るかを確かめている曲の位置。押したあとで曲数が変わっていたら無効（確認を出さない） */
  const backTarget =
    confirmBack && confirmBack.length === path.length && confirmBack.index < path.length - 1
      ? confirmBack.index
      : null;

  return (
    <main className="relative z-1 mx-auto max-w-4xl px-3 pb-nav sm:px-4">
      {/* ── 今かけている曲。ここが常に基準なので上に貼り付けておく ── */}
      <header className="sticky top-0 z-20 -mx-3 border-b border-border bg-bg/90 px-3 pb-3 pt-3 backdrop-blur-md sm:-mx-4 sm:px-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <span className="label">{performing ? "本番 · 今かけている曲" : "今かけている曲"}</span>
            {/*
              曲名は刈らずに折り返すので2〜3行になる。角を丸め切る（rounded-full）と、
              丸みが1行目と最後の行の端に掛かって字が欠けて見えた。行き先のチップと同じ角にする
            */}
            <div
              className="mt-1 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-card border border-hot/50 bg-hot/12 px-3.5 py-1.5"
            >
              <span className="min-w-0 break-words text-[17px] font-bold leading-tight text-hot">
                {current.name}
              </span>
              <span className="shrink-0 whitespace-nowrap font-mono text-[11.5px] tabular-nums text-hot/80">
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
              onClick={() => { setConfirmReset(false); setConfirmBack(null); setPicking(true); }}
              className="tap rounded-full border border-border bg-surface px-3 text-[12.5px] text-fg-subtle hover:text-fg"
              title="記録に無い曲へも移れます。かけてきた順はそのまま残ります"
            >
              曲を変える
            </button>
          </div>
        </div>

        {/* かけてきた順。押すと、確かめてからそこまで戻る */}
        {path.length > 1 && (
          <nav ref={crumbsRef} className="mt-2 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-[12px] text-fg-subtle">
            {path.slice(0, -1).map((id, i) => (
              <span key={`${id}-${i}`} className="shrink-0">
                {i > 0 && <span className="mx-1">→</span>}
                <button
                  onClick={() => { setConfirmReset(false); setConfirmBack({ index: i, length: path.length }); }}
                  className={backTarget === i ? "text-warn" : "hover:text-fg-muted"}
                >
                  {trackById.get(id)?.name ?? "?"}
                </button>
              </span>
            ))}
            <span className="mx-1 shrink-0">→</span>
            <span className="shrink-0 text-fg-muted">今</span>
          </nav>
        )}

        {/*
          戻る前に確かめる。以前は1タップで、押した曲より後ろが全部外れていた
          （「戻す」を狙った指が当たるだけでセットの後半が消える。暗いブースでは普通に起きる）。
          外れる曲の名前まで出す = 何が消えるのかを読んでから押せる
        */}
        {backTarget !== null && (
          <div role="alertdialog" aria-labelledby="play-back-question" className="mt-2 rounded-card border border-warn/50 bg-warn/10 p-3">
            <p id="play-back-question" className="text-[14px] font-semibold leading-snug break-words">
              本当に「{trackById.get(path[backTarget])?.name ?? "不明な曲"}」まで戻りますか？
            </p>
            <p className="mt-1 text-[12.5px] leading-snug break-words text-fg-muted">
              その後にかけた{path.length - 1 - backTarget}曲（
              {path.slice(backTarget + 1).map((id) => trackById.get(id)?.name ?? "不明な曲").join(" → ")}
              ）は、かけてきた順から外れます。
            </p>
            <div className="mt-2.5 flex gap-2">
              <button
                onClick={() => { setSteps((s) => s.slice(0, backTarget + 1)); setConfirmBack(null); }}
                className="tap flex-1 rounded-card border border-warn/60 bg-warn/15 px-4 text-[14px] font-semibold text-warn"
              >
                戻る
              </button>
              <button
                onClick={() => setConfirmBack(null)}
                className="tap flex-1 rounded-card border border-border bg-surface px-4 text-[14px] text-fg-muted hover:text-fg"
              >
                やめる
              </button>
            </div>
          </div>
        )}

        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[12px] text-fg-subtle">
          <span>かけた {path.length}曲</span>
          <span className={remaining > 1 ? "text-hot" : ""}>
            {remaining > 1 ? `この先 最大${remaining}曲` : "行き止まり"}
          </span>
          {hiddenPlayed > 0 && <span>かけた曲（リミックス違い含む）で隠した繋ぎ {hiddenPlayed}</span>}
          {hiddenFiltered > 0 && <span className="text-warn">条件で外した繋ぎ {hiddenFiltered}</span>}
          <button
            onClick={() => setFilterOpen((v) => !v)}
            aria-expanded={filterOpen}
            className={`tap ml-auto rounded-full border px-3 text-[12px] ${
              filtering
                ? "border-warn/50 bg-warn/10 text-warn"
                : "border-border text-fg-subtle hover:text-fg"
            }`}
          >
            {filtering ? `除外: ${filterSummary(filter)}` : "除外条件"}
          </button>
        </p>
      </header>

      {filterOpen && <FilterPanel filter={filter} onChange={setFilter} onClose={() => setFilterOpen(false)} />}

      {rows.length === 0 ? (
        <p className="mt-8 rounded-card border border-border bg-surface p-5 text-[14px] text-fg-muted">
          {candidates.length === 0
            ? "この曲から繋げる先はまだ記録されていません。"
            : unplayed.length > 0
              ? `まだかけていない曲への繋ぎが${unplayed.length}本ありますが、どれも除外条件で外れています。`
              : "繋げる先はありますが、どれも今回かけ終わった曲です。"}
          <br />
          {unplayed.length > 0 && (
            <>
              「除外条件」を緩めると出てきます。
              <br />
            </>
          )}
          「戻す」で一つ前に戻るか、「曲を変える」で記録に無い曲へも移れます
          （移った先も、繋いだ曲として数えます）。
        </p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {rows.map(({ transition: t, to, onward: n }) => {
            const fromCue = cueById.get(t.fromCueId);
            const toCue = cueById.get(t.toCueId);
            return (
              // 枠は li が持つ。「要練習」は送るボタンの**外**に出す
              // （ボタンの中にボタンは置けないうえ、入れるとタップが曲送りに食われる）
              <li
                key={t.id}
                className="rounded-card border border-border bg-linear-to-b from-surface to-surface-2 transition-colors hover:border-border-bright active:border-hot/60"
                style={{ boxShadow: "var(--shadow-card)" }}
              >
                <button
                  onClick={() => setSteps((p) => [...p, { trackId: t.toTrackId, viaTransitionId: t.id }])}
                  className="flex w-full flex-col gap-2.5 rounded-card p-3 text-left sm:flex-row sm:gap-4 sm:p-4"
                >
                  {/*
                    ── 行き先の曲名チップ。押す対象はカード全体だが、目印はここ ──
                    スマホではカードの一番上に全幅で置き、BPM・テンポ・この先N曲はその下の行へ。
                    右の細い列（112px）に入れていたときは、曲名が「ドーナツホー / ル」と語の途中で割れ、
                    長いものは4行になっていた。sm 以上は今まで通り右の列
                  */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 sm:order-last sm:w-[190px] sm:shrink-0 sm:flex-col sm:flex-nowrap sm:items-end">
                    <span className="min-w-0 basis-full rounded-card border border-accent/45 bg-accent/10 px-2.5 py-1.5 text-left text-[15px] font-semibold leading-snug break-words text-accent sm:w-full sm:basis-auto sm:text-right">
                      {to?.name ?? "不明な曲"}
                    </span>
                    <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-fg-subtle">
                      {to?.bpm ?? "–"} {to?.musicalKey}
                    </span>
                    <TempoBadge from={current.bpm} to={to?.bpm ?? null} />
                    <span
                      className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] tabular-nums ${
                        n.count > 1
                          ? "border-hot/35 bg-hot/10 text-hot"
                          : "border-border text-fg-subtle"
                      }`}
                      title="まだかけていない曲（リミックス違いも別の曲として数えない）だけで数えた「この先つなげる曲数」"
                    >
                      {/* 打ち切ったときの数は下限なので「以上」と断る（多い方に嘘をつかない） */}
                      {n.count > 1
                        ? `この先${n.count}曲${n.truncated ? "以上" : ""}`
                        : "行き止まり"}
                    </span>
                    {/* 本番中はトグルを出さないので、印だけここに出す。
                        下見中は下の帯のトグルが同じことを言うので重ねない */}
                    {t.practice && performing && (
                      <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10.5px] text-warn">
                        要練習
                      </span>
                    )}
                  </div>

                  {/* ── どのキューからどのキューへ・どう繋ぐか（全文） ── */}
                  <div className="min-w-0 space-y-2 sm:flex-1">
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

                    {(t.technique || t.difficulty || t.rating || barsLabel(t, cueLabel(toCue)) || t.comment) && (
                      <div className="space-y-1 pt-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          {/* 除外条件の根拠が画面に無いと、なぜ残ったか読めない */}
                          {t.difficulty && (
                            <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-muted">
                              {DIFFICULTY_LABEL[t.difficulty as Difficulty] ?? t.difficulty}
                            </span>
                          )}
                          {t.rating && (
                            <span className="text-[11.5px] text-warn">{t.rating}</span>
                          )}
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
                </button>
                {/*
                  下見中（本番ボタンを押していないとき）だけ、その場で「要練習」を付け外しできる。
                  下見 = 「ここは練習が要るな」と気づく時間なので、入力画面へ戻らせない。
                  本番中は Notion へ書く入口を畳む約束なので出さない（`data-edit` でも二重に畳む）
                */}
                {!performing && (
                  <div
                    data-edit
                    className="flex items-center gap-2 border-t border-border px-3 py-1 sm:px-4"
                  >
                    <PracticeToggle id={t.id} value={t.practice} className="ml-auto" />
                  </div>
                )}
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
              onClick={() => { setConfirmBack(null); setConfirmReset(true); }}
              className="tap rounded-full border border-border px-4 text-[12.5px] text-fg-subtle hover:text-fg"
              title="ここまでを履歴に残して、最初の1曲から選び直す"
            >
              リセット
            </button>
            <Link
              href="/play/history"
              // リンクは button と違って中身を縦に寄せないので、44px の高さの上端に字が貼り付く
              className="tap inline-flex items-center rounded-full border border-border px-4 text-[12.5px] text-fg-subtle hover:text-fg"
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
  tracks, maxFrom, usedSongs, playedIds, filtering, mode, onPick, onCancel,
}: {
  tracks: Track[];
  maxFrom: Record<string, number>;
  /** すでにかけた曲（songId。リミックス違いも含む）。外しはしないが、印を付けて後ろに回す */
  usedSongs: ReadonlySet<string>;
  /** かけた曲そのもの（曲ID）。印を「かけた」と「別版をかけた」で分けるためだけに使う */
  playedIds: ReadonlySet<string>;
  /** 除外条件が入っているか。入っていても「最大◯曲」は全部の繋ぎで数えた数のまま */
  filtering: boolean;
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
          Number(usedSongs.has(a.songId)) - Number(usedSongs.has(b.songId)) ||
          (maxFrom[b.id] ?? 1) - (maxFrom[a.id] ?? 1) ||
          a.name.localeCompare(b.name, "ja"),
      );
  }, [q, tracks, maxFrom, usedSongs]);

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
        {/* 全曲ぶんを条件つきで数え直すと重いので、ここの数だけは条件を入れる前の数 */}
        {filtering && " 右の「最大◯曲」は除外条件を入れる前の数です。"}
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
              className="tap flex w-full items-center gap-3 rounded-card border border-border bg-surface px-3.5 py-1.5 text-left transition-colors hover:border-border-bright"
            >
              <span className="min-w-0 flex-1 break-words text-[15px]">
                {t.name}
                {/* 使い切りにする曲でも選べるようにはしておく（本番で戻すこともある）。印だけ付けて後ろへ */}
                {usedSongs.has(t.songId) && (
                  <span className="ml-2 inline-block whitespace-nowrap rounded border border-border px-1.5 py-0.5 align-middle text-[10.5px] text-fg-subtle">
                    {playedIds.has(t.id) ? "かけた" : "別版をかけた"}
                  </span>
                )}
              </span>
              {/*
                右の数字は幅を決めて右に揃え、2段に積む。横に並べていたときは中身で幅が変わり、
                行ごとに右端がずれたうえ、曲名が 120px 前後に押し込まれて3〜4行に割れていた
              */}
              <span className="flex w-[4.5rem] shrink-0 flex-col items-end gap-0.5 whitespace-nowrap text-right font-mono text-[11px] tabular-nums">
                <span className={(maxFrom[t.id] ?? 1) > 1 ? "text-hot" : "text-fg-subtle"}>
                  {(maxFrom[t.id] ?? 1) > 1 ? `最大${maxFrom[t.id]}曲` : "行き止まり"}
                </span>
                <span className="text-fg-subtle">
                  {t.bpm ?? "–"} {t.musicalKey}
                </span>
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

/** 除外条件を短く言う（ヘッダのボタンに出す）。`Middleまで・★★★以上` */
function filterSummary(f: PlayFilter): string {
  const parts: string[] = [];
  if (f.maxDifficulty) parts.push(`${f.maxDifficulty}まで`);
  if (f.minStars > 0) parts.push(`${"★".repeat(f.minStars)}以上`);
  return parts.join("・");
}

/**
 * 除外条件の設定。どちらも「ここまで使う」の1軸なので、以上/以下を読ませずに
 * 選択肢そのものに言い切らせる（「全部」「Middle まで」「Easy だけ」）。
 * 未入力の繋ぎはどの条件でも外さない。
 */
function FilterPanel({
  filter, onChange, onClose,
}: {
  filter: PlayFilter;
  onChange: (f: PlayFilter) => void;
  onClose: () => void;
}) {
  const chip = (on: boolean) =>
    `tap rounded-full border px-3.5 text-[13px] transition-colors ${
      on ? "border-accent/60 bg-accent/12 text-accent" : "border-border bg-surface text-fg-muted hover:text-fg"
    }`;
  const difficultyChoices: { value: string | null; label: string }[] = [
    { value: null, label: "全部" },
    ...DIFFICULTIES.slice(0, -1).reverse().map((d, i, arr) => ({
      value: d,
      label: i === arr.length - 1 ? `${d} だけ` : `${d} まで`,
    })),
  ];
  const starChoices = [0, ...RATINGS.slice(1).map((_, i) => i + 2)];

  return (
    <section className="mt-3 space-y-3 rounded-card border border-border bg-surface p-3">
      <div>
        <span className="label">難易度 · 難しい繋ぎを外す</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {difficultyChoices.map((c) => (
            <button
              key={c.label}
              onClick={() => onChange({ ...filter, maxDifficulty: c.value })}
              className={chip(filter.maxDifficulty === c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="label">評価 · 星の少ない繋ぎを外す</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {starChoices.map((n) => (
            <button
              key={n}
              onClick={() => onChange({ ...filter, minStars: n })}
              className={chip(filter.minStars === n)}
            >
              {n === 0 ? "全部" : `${"★".repeat(n)} 以上`}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[12px] leading-snug text-fg-subtle">
        難易度・評価が未入力の繋ぎは外しません。条件はこの端末に残り、リセットしても消えません。
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => onChange(NO_FILTER)}
          className="tap flex-1 rounded-card border border-border px-4 text-[13px] text-fg-muted hover:text-fg"
        >
          条件を外す
        </button>
        <button
          onClick={onClose}
          className="tap flex-1 rounded-card border border-border bg-surface-2 px-4 text-[13px] text-fg hover:border-border-bright"
        >
          閉じる
        </button>
      </div>
    </section>
  );
}
