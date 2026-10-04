"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CommentEditor } from "./CommentEditor";
import { usePerformance } from "./PerformanceMode";
import { PracticeToggle } from "./PracticeToggle";
import { FilterPanel } from "./FilterPanel";
import { TargetPanel } from "./TargetPanel";
import { RatingPicker } from "./RatingPicker";
import { TempoBadge } from "./TempoBadge";
import { HopDetails, KeyMatchBadge } from "./HopDetails";
import { RouteSteps } from "./RouteSteps";
import { SaveAsPlaylist } from "./SaveAsPlaylist";
import { canFollow, minutesLabel, setLength, timingOf } from "@/lib/duration";
import { bpmDelta } from "@/lib/format";
import {
  archive, NO_FILTER, readCurrent, readFilter, readPlan, readTarget, writeCurrent, writeFilter, writePlan,
  writeTarget,
  type PlayFilter, type PlayStep,
} from "@/lib/playlog";
import {
  filterChoices, filterSummary, isFiltering, passesFilter, skipsTrack as skipsTrackBy,
} from "@/lib/playFilter";
import { maxOnwardFrom } from "@/lib/route";
import { fitRoute, hasTarget, NO_TARGET, targetLabel, type SetTarget } from "@/lib/setTarget";
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
 * ★ 除外条件（難易度「◯まで」・星「◯以上」・要練習・行き先のジャンル）で繋ぎを外せる。外した繋ぎは**無いものとして**
 *   「この先◯曲」も数え直す（カードだけ隠すと、外した繋ぎを通った数と並びが残る）。
 *   難易度・星・ジャンルが未入力なら外さない。条件は端末に残り、リセットしても消えない（`lib/playlog.ts`）。
 *   Notion に何も書かないので `data-edit` は付けない（本番中に緩められないと困る）。
 */

/** 「次にこの画面を開いたら一度取り直す」の印（タブごと）。PlayDeck の中の取り直しの説明を参照 */
const STALE = "rg.play.stale";
const markStale = () => {
  try { sessionStorage.setItem(STALE, "1"); } catch { /* 残せなければ取り直さないだけ */ }
};

export function PlayDeck({
  tracks, cues, transitions, maxFrom, maxRoute, initialTrackId,
}: {
  tracks: Track[];
  cues: Cue[];
  transitions: Transition[];
  /**
   * 全曲を使える前提の「この先最大◯曲」。曲を選ぶ一覧の並びにだけ使う。
   * 繋ぎのカードに出す数は、かけた曲を外して端末で数え直す
   */
  maxFrom: Record<string, number>;
  /** その数を出した道筋（繋ぎID）。曲を選ぶ一覧で「最大◯曲」を開くと読める */
  maxRoute: Record<string, string[]>;
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
   * かけてきた順で押した曲の位置（「本当に戻りますか？」を出している間だけ）。
   * かけてきた順が変わったら**どんな変わり方でも**取り下げる（ずれた位置で戻らせない）。
   * 以前は曲数だけで見ていたので、「戻す」→ 別の曲へ送る、のように数が同じに戻ると古い確認が生き返った。
   * そのため steps は `changeSteps` からしか変えない
   */
  const [confirmBack, setConfirmBack] = useState<number | null>(null);
  /** かけてきた順を変える唯一の口。戻る確認（`confirmBack`）を必ず一緒に取り下げる */
  const changeSteps = (next: PlayStep[] | ((cur: PlayStep[]) => PlayStep[])) => {
    setConfirmBack(null);
    setSteps(next);
  };
  /** 除外条件。端末に残したものを mount 後に読む */
  const [filter, setFilter] = useState<PlayFilter>(NO_FILTER);
  const [filterOpen, setFilterOpen] = useState(false);
  /** 長さ指定（何曲・何分のセットにしたいか）。端末に残したものを mount 後に読む */
  const [target, setTarget] = useState<SetTarget>(NO_TARGET);
  /**
   * 「セットを組む」（`/play/plan`）で「この順で始める」を押したときの道筋（繋ぎ ID）。
   * その繋ぎのカードに「予定」の印を付けるだけで、**並びは変えない**（並びは「この先◯曲」順の約束）
   */
  const [planned, setPlanned] = useState<ReadonlySet<string>>(new Set());
  /**
   * 下見中にその場で直した分（星・要練習・コメント）。画面は取り直さずに、手元の行へ重ねる。
   * 1タップごとに `router.refresh()` すると、そのたびに Notion を全件読み直し、全曲ぶんの
   * 「この先◯曲」もサーバで数え直す（続けて押すと重いうえ、Notion の上限に当たる）。
   * 重ねた値は除外条件と「この先◯曲」にもそのまま効く。
   * サーバから新しい一覧が届いたら（開き直したとき）、そちらが正なので重ねた分は捨てる
   */
  const [patches, setPatches] = useState<Record<string, Partial<Transition>>>({});
  const [seenTransitions, setSeenTransitions] = useState(transitions);
  if (seenTransitions !== transitions) { setSeenTransitions(transitions); setPatches({}); }
  const live = useMemo(
    () => transitions.map((t) => (patches[t.id] ? { ...t, ...patches[t.id] } : t)),
    [transitions, patches],
  );
  const transitionById = useMemo(() => new Map(live.map((t) => [t.id, t])), [live]);
  const patch = (id: string, p: Partial<Pick<Transition, "rating" | "practice" | "comment">>) => {
    setPatches((cur) => ({ ...cur, [id]: { ...cur[id], ...p } }));
    markStale();
  };
  /*
    戻る・進むで戻ってきたときの取り直し。Next は戻る・進むでは、最初に開いたときの画面データを
    取り直さずに使うので、ここで星などを直した後や「編集」へ出た後に戻ると、直す前の値で作り直される
    （重ねた分はこの画面の state なので、離れた時点で消えている）。そうなる操作をしたら印を残し、
    次にこの画面を開いたとき一度だけ取り直す（1タップごとに取り直さない理由は上の `patches`）
  */
  const router = useRouter();
  useEffect(() => {
    try {
      if (!sessionStorage.getItem(STALE)) return;
      sessionStorage.removeItem(STALE);
    } catch { return; }
    // `?from=` で来たときは開いたばかりの画面データなので取り直さない。下の初期化が URL から
    // `?from=` を外すのと取り直しを競わせると、取り直した結果が `?from=` 付きの URL を戻しかねない
    if (new URLSearchParams(window.location.search).has("from")) return;
    router.refresh();
  }, [router]);
  /** コメント欄を開いている繋ぎ。複数開ける（別のカードの欄を開いても、書きかけを消さない） */
  const [commenting, setCommenting] = useState<ReadonlySet<string>>(() => new Set());
  const filtering = isFiltering(filter);

  const trackById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);
  /** 何分のセットになるかを数えるための引き口（`lib/duration.ts`） */
  const lengthLookup = useMemo(() => ({
    durationSec: (id: string) => trackById.get(id)?.durationSec ?? null,
    bpm: (id: string) => trackById.get(id)?.bpm ?? null,
    cueMs: (id: string) => cueById.get(id)?.positionMs ?? null,
  }), [trackById, cueById]);
  /** 繋ぎの入る・抜ける位置。時間が逆行する道（入った位置より前から抜ける）を辿らないために使う */
  const timing = useMemo(() => (t: Transition) => timingOf(t, lengthLookup), [lengthLookup]);
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
    for (const t of live) {
      const list = m.get(t.fromTrackId) ?? [];
      list.push(t);
      m.set(t.fromTrackId, list);
    }
    return m;
  }, [live]);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    setRestored(true);
    setFilter(readFilter());
    setTarget(readTarget());
    setPlanned(new Set(readPlan().route));
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
      // 途中だったセットはここで終わる = 捨てずに履歴へ残す。
      // 曲一覧に無い曲の手も**落とさない**（履歴が「不明な曲」として出す。詰めると1手が黙って消える）
      archive(readCurrent());
      window.history.replaceState(null, "", "/play");
      return;
    }
    // 端末に残した続きが正。空なら（リセット済みなど）古い指定の曲も使わず、最初の1曲から選ぶ。
    // 曲一覧に無い曲（rekordbox から消えた・同期範囲から外れた）の手も落とさない — 落とすと
    // 下の writeCurrent がそのまま書き戻し、セットの途中が黙って消える。表示で「不明な曲」と出す
    setSteps(readCurrent());
  }, [initialTrackId]);

  useEffect(() => {
    if (!restored) return;
    writeCurrent(steps);
  }, [steps, restored]);
  useEffect(() => {
    if (restored) writeFilter(filter);
  }, [filter, restored]);
  useEffect(() => {
    if (restored) writeTarget(target);
  }, [target, restored]);

  /**
   * 除外条件を通る繋ぎか。**未入力は通す**（難易度・星は後から付けていくもので、
   * 未入力を外すと条件を入れた途端にほとんどの繋ぎが消える）
   */
  /**
   * ジャンル・My Tag の条件で外す曲か。繋ぎの判定（行き先の曲）と、曲を選ぶ一覧の
   * 並び（外した曲は印を付けて後ろへ）の両方で使う。判定は `lib/playFilter.ts`
   */
  const skipsTrack = useMemo(() => (to: Track | undefined) => skipsTrackBy(filter, to), [filter]);
  const passes = useMemo(
    () => (t: Transition) => passesFilter(filter, t, trackById.get(t.toTrackId)),
    [filter, trackById],
  );
  /** 除外条件に出すジャンルと My Tag = 繋ぎの行き先になっている曲に付いているものだけ */
  const { genres, tagGroups } = useMemo(() => {
    const dests = [...new Set(live.map((t) => t.toTrackId))]
      .map((id) => trackById.get(id))
      .filter((t): t is Track => !!t);
    return filterChoices(dests, filter);
  }, [live, trackById, filter]);

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
  // 今の曲が変わったらコメント欄は畳む（「戻す」で戻ってきたとき、前に開いた欄が空のまま開いて出ないように）
  const [commentingAt, setCommentingAt] = useState(currentId);
  if (commentingAt !== currentId) { setCommentingAt(currentId); setCommenting(new Set()); }
  const toggleComment = (id: string, open: boolean) =>
    setCommenting((cur) => {
      const next = new Set(cur);
      if (open) next.add(id); else next.delete(id);
      return next;
    });
  /**
   * 今の曲。**曲一覧に無い曲（rekordbox から消えた・同期範囲から外れた）でも「今の曲」のまま**にする —
   * ここで「曲が無い」扱いにすると、最初の1曲を選ぶ一覧に落ち、選んだ途端にセットが作り直されていた。
   * 見出しは「不明な曲」と出し、「戻す」「曲を変える」はそのまま使える。判定は `currentId` で行い、
   * `current` は名前・BPM などを引くときだけ使う
   */
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
    () => (currentId ? outgoing.get(currentId) ?? [] : []),
    [currentId, outgoing],
  );
  /** 今の曲へ入ってきた繋ぎ。「曲を変える」で移った曲・最初の1曲は無い（= 頭から流す） */
  const viaId = steps[steps.length - 1]?.viaTransitionId ?? null;
  const via = viaId ? live.find((t) => t.id === viaId) ?? null : null;
  const enteredAt = via ? timing(via) : null;
  const unplayed = candidates.filter((t) => !usedSongs.has(songOf(t.toTrackId)));
  const passable = unplayed.filter(passes);
  /**
   * 今の曲に**入った位置より前（同じ位置も）のキューから抜ける繋ぎ**は繋がりとして出さない
   * （時間が逆行する。判定は `canFollow`）。「この先◯曲」の探索も同じ判定で辿る
   */
  const open = passable.filter((t) => canFollow(enteredAt, timing(t)));
  /** かけた曲で隠した数・条件で外した数・時間が逆行する数は別の話なので分けて出す */
  const hiddenPlayed = candidates.length - unplayed.length;
  const hiddenFiltered = unplayed.length - passable.length;
  const hiddenReversed = passable.length - open.length;

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
    if (!currentId) return [];
    const list = open.map((t) => {
      const to = trackById.get(t.toTrackId);
      return {
        transition: t,
        to,
        onward: maxOnwardFrom(usable, songOf, t.toTrackId, usedSongs, timing, timing(t)),
        tempo: Math.abs(bpmDelta(current?.bpm ?? null, to?.bpm ?? null) ?? 999),
      };
    });
    list.sort(
      (a, b) =>
        b.onward.count - a.onward.count ||
        a.tempo - b.tempo ||
        (a.to?.name ?? "").localeCompare(b.to?.name ?? "", "ja") ||
        a.transition.id.localeCompare(b.transition.id),
    );
    // この繋ぎで入ってから、先の一番長い道筋を最後まで流すと何分か（入った位置から数える）
    return list.map((row) => ({
      ...row,
      length: setLength(row.onward.trackIds, row.onward.edges, lengthLookup, row.transition),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, current, open.map((t) => t.id).join(","), usedSongs, usable, songOf, trackById, lengthLookup, timing]);

  /** 今の曲から先、あと何曲つなげるか（今の曲を含む）。今の曲の songId は起点なので外す */
  const ahead = currentId
    ? maxOnwardFrom(
        usable,
        songOf,
        currentId,
        new Set([...usedSongs].filter((s) => s !== songOf(currentId))),
        timing,
        enteredAt,
      )
    : null;
  const remaining = ahead?.count ?? 0;
  /**
   * 今の曲から、その道筋を最後まで流すと何分か。今の曲は**入った位置から**数える
   * （どこまで流したかは端末に分からないので、今の曲の分は丸ごと入る）
   */
  const aheadLength = ahead
    ? setLength(ahead.trackIds, ahead.edges, lengthLookup, via)
    : null;

  // かけてきた順は右端（最新）を見せる。横スクロールの箱は左端から始まるので、
  // スマホでは2〜3曲で最新側と「→ 今」が画面の外に切れていた
  const crumbsRef = useRef<HTMLElement>(null);
  /**
   * 下へ送ったら、上に貼り付けた「今かけている曲」を1行に畳む（かけてきた順と数の行を隠す）。
   * 画面の2割を取ったままだと、本番中に次の候補が1枚半しか見えなかった。
   *
   * ★ **畳んでも、ページの高さは変えない。** 畳んで縮んだぶん（約100px）だけ見出しの直後に
   *   空き（`spacerRef`）を足す。高さが変わると、その下の一覧が上へ詰まり、ブラウザのスクロール
   *   アンカリングや「ページ末尾で scrollY が縮む」で scrollY が動いて境目をまたぎ、
   *   畳む・開くを行ったり来たりしていた（念のため `<main>` のアンカリングも切っている）。
   * ★ 境目は**開いたときの見出しの高さ**（測った値）。畳むのはそれより下まで送ったとき、
   *   開くのはそこから 24px 戻ったとき。畳んでいる間、足した空きは必ず見出しの下に隠れるか
   *   画面の上へ抜けている（固定の 96px だと、空きが見出しの下に帯として見えた）
   */
  const [compact, setCompact] = useState(false);
  /** 見出しが出ているか（曲を選ぶ一覧の間は無い）。戻ってきたら見出しを測り直す */
  const deckShown = !!currentId && !picking;
  const headerRef = useRef<HTMLElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  /** 開いたときの見出しの高さ。0 = まだ測っていない */
  const expandedH = useRef(0);
  useEffect(() => {
    const onScroll = () => {
      // 曲を選ぶ一覧を開いている間は見出しが無い。戻ってきたら開いた形から測り直す
      if (!headerRef.current) { setCompact(false); return; }
      const y = window.scrollY;
      const full = expandedH.current || 96;
      setCompact((c) => (c ? y > full - 24 : y > full));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // 描く前に（`useLayoutEffect`）空きの高さを DOM へ直接書く。state を通すと、空きが 0 の
  // 1コマが挟まってページが縮む = 防ぎたいずれそのものが起きる
  useLayoutEffect(() => {
    const header = headerRef.current;
    const spacer = spacerRef.current;
    if (!header || !spacer) return;
    const fit = () => {
      // 測る（= レイアウトが走る）前に、空きを開いたときの高さぶん先に入れておく。
      // 畳んだ見出しだけでレイアウトが走ると、その瞬間にページが縮み、末尾近くでは
      // scrollY がページの長さに合わせて切り詰められる（空きを足しても戻らない。実際に 268 → 120 に飛んだ）
      if (compact) spacer.style.height = `${expandedH.current}px`;
      const h = header.offsetHeight;
      if (!compact) {
        expandedH.current = h;
        spacer.style.height = "0px";
      } else {
        spacer.style.height = `${Math.max(0, expandedH.current - h)}px`;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(header);
    return () => ro.disconnect();
  }, [compact, deckShown]);
  // 畳んでいる間はかけてきた順を出さないので、開き直したときにも右端（最新）へ送り直す
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path, compact]);

  // 曲が決まっていない（＝最初の1曲）と、途中で別の曲へ移るときは同じ一覧を出す。
  // 違うのは選んだ結果だけ: 前者は「そこから始める」、後者は「後ろに足す」
  /**
   * 曲を選ぶ一覧の「最大◯曲」と開く道筋を、**除外条件を入れたら数え直す**。
   * 条件なしのときはサーバで数えた数（全曲ぶん・打ち切り無し）をそのまま使う。
   * 全曲ぶんの探索は重いので、一覧を開いていて条件が入っているときだけ、条件が変わったら1回走らせる
   * （検索欄の1文字ごとには走らせない。依存に検索語を入れない）
   */
  const pickerOpen = !deckShown;
  const filteredCounts = useMemo(() => {
    if (!pickerOpen || !filtering) return null;
    const max: Record<string, number> = {};
    const route: Record<string, string[]> = {};
    const truncated = new Set<string>();
    for (const t of tracks) {
      const r = maxOnwardFrom(usable, songOf, t.id, new Set(), timing);
      max[t.id] = r.count;
      if (r.edges.length > 0) route[t.id] = r.edges.map((e) => e.id);
      if (r.truncated) truncated.add(t.id);
    }
    return { max, route, truncated };
  }, [pickerOpen, filtering, tracks, usable, songOf, timing]);

  /** 除外条件のボタンと設定。プレイ中のヘッダと、曲を選ぶ一覧の両方に置く */
  const filterButton = (
    <button
      onClick={() => setFilterOpen((v) => !v)}
      aria-expanded={filterOpen}
      className={`btn px-3 text-[12px] ${filtering ? "btn-warn" : ""}`}
    >
      {filtering ? `除外: ${filterSummary(filter)}` : "除外条件"}
    </button>
  );
  const filterPanel = filterOpen && (
    <FilterPanel
      filter={filter}
      genres={genres}
      tagGroups={tagGroups}
      onChange={setFilter}
      onClose={() => setFilterOpen(false)}
    />
  );

  if (!currentId || picking) {
    return (
      <StartPicker
        tracks={tracks}
        maxFrom={filteredCounts?.max ?? maxFrom}
        maxRoute={filteredCounts?.route ?? maxRoute}
        transitionById={transitionById}
        trackById={trackById}
        cueById={cueById}
        truncated={filteredCounts?.truncated ?? null}
        filterButton={filterButton}
        filterPanel={filterPanel}
        usedSongs={usedSongs}
        playedIds={new Set(path)}
        skipsTrack={skipsTrack}
        filtering={filtering}
        target={target}
        onTarget={setTarget}
        lengthLookup={lengthLookup}
        mode={currentId ? "jump" : "start"}
        onPick={(id, route) => {
          setPicking(false);
          // 道筋を開いて「この曲から始める」を押したら、その道筋の繋ぎに「予定」の印を付ける
          if (route && !currentId) {
            writePlan({ ...readPlan(), route });
            setPlanned(new Set(route));
          }
          // 記録に無い繋ぎで移ったときは繋ぎ ID を残さない（履歴でもそう出す）
          changeSteps((p) =>
            currentId
              ? [...p, { trackId: id, viaTransitionId: null }]
              : [{ trackId: id, viaTransitionId: null }],
          );
        }}
        onCancel={currentId ? () => setPicking(false) : null}
      />
    );
  }

  /** 戻るかを確かめている曲の位置。かけてきた順が変わると `changeSteps` が取り下げる */
  const backTarget =
    confirmBack !== null && confirmBack < path.length - 1 ? confirmBack : null;

  return (
    <main className="relative z-1 mx-auto max-w-4xl px-3 pb-nav [overflow-anchor:none] sm:px-4 lg:max-w-6xl">
      {/* ── 今かけている曲。ここが常に基準なので上に貼り付けておく ── */}
      <header ref={headerRef} className={`sticky top-0 z-20 -mx-3 border-b border-border bg-bg/90 px-3 backdrop-blur-md ${compact ? "py-1.5" : "pb-3 pt-3"} sm:-mx-4 sm:px-4`}>
        <div className={`pr-corner flex gap-2 ${compact ? "items-center" : "items-start"}`}>
          <div className="min-w-0 flex-1">
            {!compact && <span className="label">{performing ? "本番 · 今かけている曲" : "今かけている曲"}</span>}
            {/*
              曲名は刈らずに折り返すので2〜3行になる。角を丸め切る（rounded-full）と、
              丸みが1行目と最後の行の端に掛かって字が欠けて見えた。行き先のチップと同じ角にする
            */}
            <div
              className={`inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-card border border-hot/50 bg-hot/12 px-3 ${compact ? "py-1" : "mt-1 py-1.5"}`}
            >
              <span className={`min-w-0 break-words font-bold leading-tight text-hot ${compact ? "text-[15px]" : "text-[17px]"}`}>
                {current?.name ?? "不明な曲"}
              </span>
              {current && (
                <span className="shrink-0 whitespace-nowrap font-mono text-[13px] tabular-nums text-hot/80">
                  {current.bpm ?? "–"}{current.musicalKey && ` ${current.musicalKey}`}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            {path.length > 1 && (
              <button
                onClick={() => changeSteps((p) => p.slice(0, -1))}
                className="btn"
              >
                戻す
              </button>
            )}
            <button
              onClick={() => { setConfirmReset(false); setConfirmBack(null); setPicking(true); }}
              className="btn"
              title="記録に無い曲へも移れます。かけてきた順はそのまま残ります"
            >
              曲を変える
            </button>
          </div>
        </div>

        {/* かけてきた順。押すと、確かめてからそこまで戻る */}
        {path.length > 1 && !compact && (
          <nav ref={crumbsRef} className="mt-2 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-[12px] text-fg-subtle">
            {path.slice(0, -1).map((id, i) => (
              <span key={`${id}-${i}`} className="shrink-0">
                {i > 0 && <span className="mx-1">→</span>}
                <button
                  onClick={() => { setConfirmReset(false); setConfirmBack(i); }}
                  className={backTarget === i ? "text-warn" : "hover:text-fg-muted"}
                >
                  {trackById.get(id)?.name ?? "不明な曲"}
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
                onClick={() => changeSteps((s) => s.slice(0, backTarget + 1))}
                className="btn btn-warn flex-1 rounded-card px-4 text-[14px] font-semibold"
              >
                戻る
              </button>
              <button
                onClick={() => setConfirmBack(null)}
                className="btn flex-1 rounded-card px-4 text-[14px]"
              >
                やめる
              </button>
            </div>
          </div>
        )}

        <p className={`mt-1.5 flex-wrap items-center gap-x-3 text-[12px] text-fg-subtle ${compact ? "hidden" : "flex"}`}>
          <span>かけた {path.length}曲</span>
          <span className={remaining > 1 ? "text-hot" : ""}>
            {/* 探索を打ち切ったときの数は下限（カードの「◯曲以上」と同じ断り方） */}
            {remaining > 1 ? `この先 最大${remaining}曲${ahead?.truncated ? "以上" : ""}` : "行き止まり"}
          </span>
          {/* 今の曲が不明なら長さは数えられない（0分と出さない） */}
          {current && aheadLength && (
            <span title="今の曲（入った位置から）を含めて、この先の一番長い道筋を最後まで流した長さ。括弧は曲を頭から最後まで流した場合">
              残り{minutesLabel(aheadLength.cutSec)}（全長{minutesLabel(aheadLength.fullSec).replace("約", "")}）
            </span>
          )}
          {hiddenPlayed > 0 && (
            <span title="かけた曲（リミックス違いも含む）へ入る繋ぎは出さない">かけた曲で隠した {hiddenPlayed}</span>
          )}
          {hiddenFiltered > 0 && <span className="text-warn">条件で外した {hiddenFiltered}</span>}
          {hiddenReversed > 0 && (
            <span title="この曲に入った位置より前のキューから抜ける繋ぎ（時間が逆行する）">逆行で隠した {hiddenReversed}</span>
          )}
          <span className="ml-auto">{filterButton}</span>
        </p>
      </header>
      {/* 畳んで縮んだぶんの空き（上の compact の説明）。開いているときは 0 */}
      <div ref={spacerRef} aria-hidden />

      {filterPanel}

      {rows.length === 0 ? (
        <p className="mt-8 rounded-card border border-border bg-surface p-5 text-[14px] text-fg-muted">
          {!current
            ? "この曲は曲一覧に見つかりません（rekordbox から消えたか、同期の範囲から外れました）。かけてきた順には残しています。"
            : candidates.length === 0
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
        // PC では2列に並べる（1列だと横幅が余り、候補が縦に長く伸びるだけだった）。
        // 並びは「この先◯曲」順のまま、左上から右へ読む
        <ul className="mt-3 grid gap-2.5 lg:grid-cols-2 lg:items-start">
          {rows.map(({ transition: t, to, onward: n, length }) => {
            return (
              // 枠は li が持つ。「要練習」は送るボタンの**外**に出す
              // （ボタンの中にボタンは置けないうえ、入れるとタップが曲送りに食われる）
              <li
                key={t.id}
                className="rounded-card border border-border bg-linear-to-b from-surface to-surface-2 transition-colors hover:border-border-bright active:border-hot/60"
                style={{ boxShadow: "var(--shadow-card)" }}
              >
                <button
                  onClick={() => changeSteps((p) => [...p, { trackId: t.toTrackId, viaTransitionId: t.id }])}
                  className="flex w-full flex-col gap-2 rounded-card p-2.5 text-left sm:flex-row sm:gap-4 sm:p-4"
                >
                  {/*
                    ── 行き先の曲名チップ。押す対象はカード全体だが、目印はここ ──
                    スマホではカードの一番上に全幅で置き、BPM・テンポ・この先N曲はその下の行へ。
                    右の細い列（112px）に入れていたときは、曲名が「ドーナツホー / ル」と語の途中で割れ、
                    長いものは4行になっていた。sm 以上は今まで通り右の列
                  */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 sm:order-last sm:w-[190px] sm:shrink-0 sm:flex-col sm:flex-nowrap sm:items-end">
                    <span className="min-w-0 basis-full rounded-card border border-accent/45 bg-accent/10 px-2.5 py-1 text-left text-[15px] font-semibold leading-snug break-words text-accent sm:w-full sm:basis-auto sm:text-right">
                      {to?.name ?? "不明な曲"}
                    </span>
                    <span className="whitespace-nowrap font-mono text-[13px] tabular-nums text-fg-subtle">
                      {to?.bpm ?? "–"} {to?.musicalKey}
                    </span>
                    <TempoBadge from={current?.bpm ?? null} to={to?.bpm ?? null} />
                    <KeyMatchBadge from={current?.musicalKey} to={to?.musicalKey} />
                    <span
                      className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[12px] tabular-nums ${
                        n.count > 1
                          ? "border-hot/35 bg-hot/10 text-hot"
                          : "border-border text-fg-subtle"
                      }`}
                      title="まだかけていない曲（リミックス違いも別の曲として数えない）だけで数えた「この先つなげる曲数」"
                    >
                      {/* 打ち切ったときの数は下限なので「以上」と断る（多い方に嘘をつかない） */}
                      {n.count > 1
                        ? `この先${n.count}曲${n.truncated ? "以上" : ""}・${minutesLabel(length.cutSec)}`
                        : "行き止まり"}
                    </span>
                    {planned.has(t.id) && (
                      <span
                        className="rounded border border-accent/45 bg-accent/10 px-1.5 py-0.5 text-[12px] text-accent"
                        title="「セットを組む」で出した道筋の繋ぎ"
                      >
                        予定
                      </span>
                    )}
                    {/* 本番中はトグルを出さないので、印だけここに出す。
                        下見中は下の帯のトグルが同じことを言うので重ねない */}
                    {t.practice && performing && (
                      <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[12px] text-warn">
                        要練習
                      </span>
                    )}
                  </div>

                  {/* ── どのキューからどのキューへ・どう繋ぐか（全文）。プレイリストのプレイ画面と共通 ── */}
                  <HopDetails
                    t={t}
                    from={current}
                    to={to}
                    cueById={cueById}
                    cuesByTrack={cuesByTrack}
                    showRating={performing}
                  />
                </button>
                {/*
                  下見中（本番ボタンを押していないとき）だけ、その場で星・要練習・コメントを直せる。
                  「編集」は入力画面をこの繋ぎで開く（種類・小節数・難易度・キューの付け替えなど、ここに無い項目の口）。
                  下見 = 「ここは練習が要る」「ここはこう繋ぐ」と気づく時間なので、入力画面へ戻らせない。
                  本番中は Notion へ書く入口を畳む約束なので出さない（`data-edit` でも二重に畳む）。
                  保存しても画面は取り直さない（`refresh={false}`）。手元の行に重ねる（上の `patches`）
                */}
                {!performing && (
                  <div data-edit className="border-t border-border px-3 py-1 sm:px-4">
                    {/*
                      曲ページのカードと同じ並び。スマホでは星（180px）と操作が1行に収まらないので、
                      操作はひとまとめにして次の行の右端へ落とす（1段目 = 評価と星、2段目 = 操作）
                    */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="label">評価</span>
                      <RatingPicker
                        id={t.id}
                        value={t.rating}
                        refresh={false}
                        onSaved={(rating) => patch(t.id, { rating })}
                        className="-my-0.5 ml-auto"
                      />
                      <span className="ml-auto flex items-center gap-2 sm:ml-0">
                        <PracticeToggle
                          id={t.id}
                          value={t.practice}
                          refresh={false}
                          onSaved={(practice) => patch(t.id, { practice })}
                        />
                        <button
                          type="button"
                          onClick={() => toggleComment(t.id, !commenting.has(t.id))}
                          aria-expanded={commenting.has(t.id)}
                          title="この繋ぎのコメントを、ここで書き足す・直す"
                          className={`btn px-3 text-[12px] ${commenting.has(t.id) ? "btn-accent" : ""}`}
                        >
                          コメント
                        </button>
                        <Link
                          href={`/new?edit=${t.id}`}
                          // 入力画面で直して「戻る」で帰ってきたら、この画面を取り直す（上の STALE）
                          onClick={markStale}
                          className="btn px-3 text-[12px]"
                          title="この繋ぎのキュー・種類・小節数・難易度などを直す"
                        >
                          編集
                        </Link>
                      </span>
                    </div>
                    {commenting.has(t.id) && (
                      <CommentEditor
                        id={t.id}
                        value={t.comment}
                        onSaved={(comment) => { patch(t.id, { comment }); toggleComment(t.id, false); }}
                        onClose={() => toggleComment(t.id, false)}
                      />
                    )}
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
              onClick={() => {
                setConfirmReset(false); archive(steps); changeSteps([]);
                // セットを終えたら、組んだ道筋の「予定」も終わり（選んだ曲は残す）
                writePlan({ ...readPlan(), route: [] }); setPlanned(new Set());
              }}
              className="btn btn-warn px-4"
            >
              リセットする
            </button>
            <button
              onClick={() => setConfirmReset(false)}
              className="btn"
            >
              やめる
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => { setConfirmBack(null); setConfirmReset(true); }}
              className="btn px-4"
              title="ここまでを履歴に残して、最初の1曲から選び直す"
            >
              リセット
            </button>
            <Link
              href="/play/history"
              className="btn px-4"
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
 * 長さ指定があるときだけは、右に出す数と同じ「枠で切った後の曲数 → 長さ」で並べる。
 */
function StartPicker({
  tracks, maxFrom, truncated, filterButton, filterPanel,
  usedSongs, playedIds, skipsTrack, filtering, mode, onPick, onCancel,
  maxRoute, transitionById, trackById, cueById, target, onTarget, lengthLookup,
}: {
  tracks: Track[];
  /** 除外条件が入っていれば、条件を通る繋ぎだけで数え直した数 */
  maxFrom: Record<string, number>;
  maxRoute: Record<string, string[]>;
  transitionById: ReadonlyMap<string, Transition>;
  trackById: ReadonlyMap<string, Track>;
  cueById: ReadonlyMap<string, Cue>;
  /** 端末で数え直したときに探索を打ち切った曲（数は下限 =「以上」を付ける）。サーバの数なら null */
  truncated: ReadonlySet<string> | null;
  filterButton: React.ReactNode;
  filterPanel: React.ReactNode;
  /** すでにかけた曲（songId。リミックス違いも含む）。外しはしないが、印を付けて後ろに回す */
  usedSongs: ReadonlySet<string>;
  /** かけた曲そのもの（曲ID）。印を「かけた」と「別版をかけた」で分けるためだけに使う */
  playedIds: ReadonlySet<string>;
  /**
   * ジャンル・My Tag の条件で外した曲か。かけた曲と同じく**外しはしない**で、印を付けて後ろに回す
   * （条件は「そこへは繋がない」なので、一覧に上から並ぶと条件が効いていないように見える。
   * 消すと本番の急な差し替えで、条件を外しに戻らないと選べなくなる）
   */
  skipsTrack: (t: Track) => boolean;
  /** 除外条件が入っているか（入っていれば右の数は条件つきで数え直したもの） */
  filtering: boolean;
  mode: "start" | "jump";
  /**
   * 長さ指定（`lib/setTarget.ts`）。**最初の1曲を選ぶときだけ効く** —
   * 「曲を変える」（急な差し替え）では全曲から選べないと困るので、枠では絞らない
   */
  target: SetTarget;
  onTarget: (t: SetTarget) => void;
  lengthLookup: Parameters<typeof fitRoute>[2];
  /** route = 道筋を開いてから選んだときの、その道筋（繋ぎ ID） */
  onPick: (id: string, route?: string[]) => void;
  /** 途中で開いたときだけ「やめる」で戻れる（かけてきた順は消さない） */
  onCancel: (() => void) | null;
}) {
  const [q, setQ] = useState("");
  /** 「最大◯曲」を開いている曲。開くのは1曲ずつ（84曲ぶん開くと一覧が読めなくなる） */
  const [openId, setOpenId] = useState<string | null>(null);
  const [targetOpen, setTargetOpen] = useState(false);
  const targeting = mode === "start" && hasTarget(target);
  /**
   * 各曲の一番長い道筋を、長さ指定の枠に収まるところで切ったもの。枠が無ければ道筋そのまま。
   * 枠に収まる切り方が無い曲は null（一覧から外す）
   */
  const fitted = useMemo(() => {
    const m = new Map<string, { edges: Transition[]; songs: number; cutSec: number } | null>();
    for (const t of tracks) {
      const edges = (maxRoute[t.id] ?? [])
        .map((id) => transitionById.get(id))
        .filter((e): e is Transition => !!e);
      if (!targeting) { m.set(t.id, { edges, songs: edges.length + 1, cutSec: 0 }); continue; }
      const r = fitRoute(t.id, edges, lengthLookup, target);
      m.set(t.id, r && { edges: r.hops, songs: r.trackIds.length, cutSec: r.length.cutSec });
    }
    return m;
  }, [tracks, maxRoute, transitionById, lengthLookup, target, targeting]);
  /** 開ける道筋があるか（枠で切った結果、1曲だけになったら開くものが無い） */
  const hasRoute = (id: string) => (fitted.get(id)?.edges.length ?? 0) > 0;
  /**
   * 枠で外した曲を、道筋を持っていた曲と繋ぎの無い曲に分けて数える（文言を実際に起きたことに合わせる）。
   * 繋ぎの無い曲は「1曲だけ」の道筋なので、「◯曲以上」「◯分以上」が入っていなければ外れない
   */
  const hiddenByTarget = targeting ? tracks.filter((t) => maxRoute[t.id] && !fitted.get(t.id)).length : 0;
  const hiddenLoners = targeting ? tracks.filter((t) => !maxRoute[t.id] && !fitted.get(t.id)).length : 0;
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    return tracks
      .filter((t) => {
        if (targeting && !fitted.get(t.id)) return false;
        const hay = `${t.name} ${t.alias} ${t.fullTitle}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort(
        (a, b) =>
          Number(usedSongs.has(a.songId)) - Number(usedSongs.has(b.songId)) ||
          Number(skipsTrack(a)) - Number(skipsTrack(b)) ||
          // 長さ指定があるときは、右に出している数（枠で切った後の曲数 → 長さ）で並べる。
          // 切る前の「最大◯曲」で並べると、画面の数と並びが食い違う
          (targeting
            ? (fitted.get(b.id)?.songs ?? 0) - (fitted.get(a.id)?.songs ?? 0) ||
              (fitted.get(b.id)?.cutSec ?? 0) - (fitted.get(a.id)?.cutSec ?? 0)
            : (maxFrom[b.id] ?? 1) - (maxFrom[a.id] ?? 1)) ||
          a.name.localeCompare(b.name, "ja"),
      );
  }, [q, tracks, maxFrom, usedSongs, skipsTrack, targeting, fitted]);

  return (
    <main className="relative z-1 mx-auto max-w-2xl px-4 pb-nav pt-4">
      <div className="pr-corner flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-[22px] font-bold tracking-tight">
          {mode === "jump" ? "次にかける曲" : "最初にかける曲"}
        </h1>
        {onCancel && (
          <button
            onClick={onCancel}
            className="btn"
          >
            やめる
          </button>
        )}
      </div>
      <p
        className="mt-1 text-[13px] text-fg-muted"
        title={`長くつなげる曲が上です。${filtering ? "右の数は、除外条件で外した繋ぎを通らずに数えています。" : ""}`}
      >
        {mode === "jump" ? "記録に無い曲へも、続きとして移れます。" : "右の「最大◯曲」を押すと道筋が開きます。"}
      </p>
      {/*
        セットを組む・プレイリスト・前のセットへの入口は1行の小さいボタンにまとめる。
        大きいボタンを3段積んでいた頃は、肝心の曲の一覧が画面の下半分へ押し出されていた。
        リセットの直後に立つのがこの画面なので、**一覧より上に**置くことは変えない
      */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {mode === "start" && (
          <>
            <Link href="/play/plan" className="btn btn-accent px-3">
              セットを組む
            </Link>
            <Link href="/playlists" className="btn btn-accent px-3">
              プレイリスト
            </Link>
            <Link href="/play/history" className="btn px-3">
              履歴
            </Link>
          </>
        )}
        <span className="ml-auto flex gap-1.5">
          {mode === "start" && (
            <button
              onClick={() => setTargetOpen((v) => !v)}
              aria-expanded={targetOpen}
              className={`btn px-3 text-[12px] ${targeting ? "btn-accent" : ""}`}
            >
              {targeting ? `長さ: ${targetLabel(target)}` : "長さ指定"}
            </button>
          )}
          {filterButton}
        </span>
      </div>
      {mode === "start" && targetOpen && (
        <TargetPanel target={target} onChange={onTarget} onClose={() => setTargetOpen(false)} />
      )}
      {filterPanel}
      {(hiddenByTarget > 0 || hiddenLoners > 0) && (
        <p className="mt-2 text-[12px] text-fg-subtle">
          「{targetLabel(target)}」に収まらない
          {[
            hiddenByTarget > 0 && `${hiddenByTarget}曲`,
            hiddenLoners > 0 && `繋ぎの無い${hiddenLoners}曲`,
          ].filter(Boolean).join("と、")}
          を外しています。
        </p>
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
          <li
            key={t.id}
            className={`rounded-card border bg-surface transition-colors ${
              openId === t.id ? "border-border-bright" : "border-border hover:border-border-bright"
            }`}
          >
            {/*
              曲名を押すと選ぶ、右の数字を押すとその道筋が開く。ボタンの中にボタンは置けないので、
              1枚のカードの中で2つに分けている
            */}
            <div className="flex items-stretch">
            <button
              onClick={() => onPick(t.id)}
              className="tap flex min-w-0 flex-1 items-center py-1.5 pl-3.5 pr-2 text-left"
            >
              <span className="min-w-0 flex-1 break-words text-[15px]">
                {t.name}
                {/* 使い切りにする曲でも選べるようにはしておく（本番で戻すこともある）。印だけ付けて後ろへ */}
                {usedSongs.has(t.songId) && (
                  <span className="ml-2 inline-block whitespace-nowrap rounded border border-border px-1.5 py-0.5 align-middle text-[12px] text-fg-subtle">
                    {playedIds.has(t.id) ? "かけた" : "別版をかけた"}
                  </span>
                )}
                {!usedSongs.has(t.songId) && skipsTrack(t) && (
                  <span className="ml-2 inline-block whitespace-nowrap rounded border border-warn/40 px-1.5 py-0.5 align-middle text-[12px] text-warn">
                    除外中
                  </span>
                )}
              </span>
            </button>
            {/*
              右の数字は幅を決めて右に揃え、2段に積む。横に並べていたときは中身で幅が変わり、
              行ごとに右端がずれたうえ、曲名が 120px 前後に押し込まれて3〜4行に割れていた
            */}
            <button
              onClick={() => hasRoute(t.id) && setOpenId((cur) => (cur === t.id ? null : t.id))}
              disabled={!hasRoute(t.id)}
              aria-expanded={openId === t.id}
              title="押すと、この数を出した道筋が開きます"
              className="tap flex w-[7.5rem] shrink-0 flex-col items-end justify-center gap-0.5 whitespace-nowrap py-1.5 pl-1 pr-3.5 text-right font-mono text-[12px] tabular-nums"
            >
                {targeting ? (
                  // 長さ指定があるときは、枠に収まるところで切った道筋の曲数と長さ（カット後）
                  <span className="text-hot">
                    {fitted.get(t.id)?.songs}曲・{minutesLabel(fitted.get(t.id)?.cutSec ?? 0)}
                    {(fitted.get(t.id)?.edges.length ?? 0) > 0 && <span className="ml-0.5">{openId === t.id ? "▴" : "▾"}</span>}
                  </span>
                ) : (
                  <span className={(maxFrom[t.id] ?? 1) > 1 ? "text-hot" : "text-fg-subtle"}>
                    {(maxFrom[t.id] ?? 1) > 1
                      ? `最大${maxFrom[t.id]}曲${truncated?.has(t.id) ? "以上" : ""}`
                      : "行き止まり"}
                    {maxRoute[t.id] && <span className="ml-0.5">{openId === t.id ? "▴" : "▾"}</span>}
                  </span>
                )}
                <span className="text-fg-subtle">
                  {t.bpm ?? "–"} {t.musicalKey}
                </span>
            </button>
            </div>
            {openId === t.id && hasRoute(t.id) && (() => {
              const edges = fitted.get(t.id)?.edges ?? [];
              const ids = [t.id, ...edges.map((e) => e.toTrackId)];
              return (
                <div className="border-t border-border px-3.5 pb-3 pt-2">
                  <RouteSteps trackIds={ids} edges={edges} trackById={trackById} cueById={cueById} />
                  <button
                    onClick={() => onPick(t.id, edges.map((e) => e.id))}
                    className="btn btn-hot mt-2.5 w-full rounded-card text-[13.5px]"
                  >
                    {mode === "jump" ? "この曲へ移る" : "この曲から始める"}
                  </button>
                  <SaveAsPlaylist
                    trackIds={ids}
                    edges={edges}
                    trackById={trackById}
                    defaultName={`${t.name} 始まり ${targeting ? targetLabel(target) : `最大${ids.length}曲`}`}
                  />
                </div>
              );
            })()}
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
