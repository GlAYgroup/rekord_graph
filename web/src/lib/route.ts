import { canFollow, timingOf, type Timing } from "./duration";
import type { Graph, Transition } from "./graph";

/**
 * 「この曲から最大何曲つなげるか」を出す。
 *
 * 同じ曲を2回かけることはないので、**同じ曲を通らない経路（単純path）の最長**を探す。
 * 「同じ曲」はリミックス違いも含む（`Track.songId`。判定は `lib/song.ts`）。
 * 一般には NP困難だが、対象は数十ノード・数十エッジなので素直な全探索で十分。
 * 探索が爆発しないよう、訪問数に上限を置いて打ち切る。
 *
 * 本番中（/play）は「もう使った曲」を外して数え直す必要がある。そのため探索の本体は
 * `blockedSongs` を取る形にして**ここ1箇所だけ**に置き、サーバ用（Graph を渡す）と
 * 端末用（Graph を持てないので隣接だけ渡す）の2つの入口から呼ぶ。
 *
 * ★ 曲の中で時間が逆行する道は繋がりとして数えない: 繋ぎで入った位置より前（同じ位置も）の
 *   キューから次の曲へは抜けられない（判定は `lib/duration.ts` の `canFollow`）。
 *   時刻は `timing` で渡す（渡さなければ判定しない）。
 */

export type Route = { trackIds: string[]; transitions: Transition[] };

const EMPTY: Route = { trackIds: [], transitions: [] };
const NOTHING_BLOCKED: ReadonlySet<string> = new Set();

/** サーバ側の打ち切り。全曲ぶんを一度に計算する。現実のデータでは到達しない */
const MAX_STEPS = 200_000;
/**
 * 端末で数え直すときの打ち切り。本番中に指が止まる方が困るので浅くする。
 * 打ち切った数は「少なくともこれだけは繋げる」であって正確な最大ではない。
 */
const CLIENT_MAX_STEPS = 20_000;

/** 探索に要るのは行き先だけ。Transition でも、端末へ渡す軽い形でも通る */
type Step = { toTrackId: string };

/**
 * `walkLongest` の追加の口（`planRoute` だけが使う）。
 *  - `seed`: 最初から持っている「今までの最良」。これより良い道だけを探す
 *  - `prune`: ここから先を探しても最良を超えられないなら true（上界による枝刈り）
 *  - `deadline`: `performance.now()` がこれを過ぎたら打ち切る（画面を固めない）
 */
type WalkOpts<E> = {
  seed?: { trackIds: string[]; edges: E[]; points: number };
  prune?: (
    nodeId: string,
    visitedSongs: ReadonlySet<string>,
    points: number,
    length: number,
    best: { trackIds: readonly string[]; points: number },
  ) => boolean;
  deadline?: number;
};

/**
 * 曲ID -> 同じ曲の仲間で共通の ID（`Track.songId`）。
 * **同じ曲は2回かけない**の「同じ」はこれで判定する = リミックス違いも2回目は通らない。
 * 知らない曲ID は自分自身を返す（誰とも束ねない）。
 */
export type SongOf = (trackId: string) => string;

function walkLongest<E extends Step>(
  outgoing: ReadonlyMap<string, readonly E[]>,
  songOf: SongOf,
  startId: string,
  /** もう使った曲（songId）。ここへは入らない */
  blockedSongs: ReadonlySet<string>,
  maxSteps: number,
  /** 繋ぎの時刻（入る・抜ける位置）。無ければ時間の前後は見ない */
  timing?: (e: E) => Timing,
  /** 起点の曲へ入ってきた繋ぎ（/play の「今の曲」）。起点から抜ける繋ぎもこれより後に限る */
  enteredBy: Timing | null = null,
  /**
   * 道筋の良さを決める2つの口（`planRoute` 用。渡さなければ「曲数が多いほど良い」だけ）:
   *  - `gain`: その曲を通ると何点か。**点が多い道 → 同点なら曲数が多い道**を選ぶ
   *  - `canEnd`: その曲で道筋を終えてよいか（入れたい曲で終える）。起点は終えてよい曲であること
   */
  gain?: (trackId: string) => number,
  canEnd?: (trackId: string) => boolean,
  /** `planRoute` 用の口。渡さなければ今までどおりの全探索 */
  opts: WalkOpts<E> = {},
): { trackIds: string[]; edges: E[]; truncated: boolean; points: number } {
  const startPoints = gain?.(startId) ?? 0;
  let best: { trackIds: string[]; edges: E[]; points: number } =
    opts.seed && (opts.seed.points > startPoints || (opts.seed.points === startPoints && opts.seed.trackIds.length > 1))
      ? { ...opts.seed }
      : { trackIds: [startId], edges: [], points: startPoints };
  let points = startPoints;
  let steps = 0;
  let truncated = false;
  // 枝刈りは曲（songId）で、返す道筋は曲ID で持つ。混ぜると songId が曲ID として外へ漏れる
  const visitedSongs = new Set<string>([songOf(startId)]);
  const trackTrail: string[] = [startId];
  const trail: E[] = [];

  const walk = (nodeId: string, entered: Timing | null) => {
    if (truncated) return;
    if (++steps > maxSteps) { truncated = true; return; }
    // 時刻を見るのは1024歩に1回（毎歩だと時計の方が重い）
    if (opts.deadline !== undefined && (steps & 1023) === 0 && performance.now() > opts.deadline) {
      truncated = true;
      return;
    }
    const better = points > best.points || (points === best.points && trackTrail.length > best.trackIds.length);
    if (better && (!canEnd || canEnd(nodeId))) {
      best = { trackIds: [...trackTrail], edges: [...trail], points };
    }
    if (opts.prune?.(nodeId, visitedSongs, points, trackTrail.length, best)) return;
    for (const t of outgoing.get(nodeId) ?? []) {
      const song = songOf(t.toTrackId);
      if (visitedSongs.has(song) || blockedSongs.has(song)) continue; // 同じ曲（リミックス違い含む）は2回かけない
      const time = timing?.(t) ?? null;
      if (time && !canFollow(entered, time)) continue; // 入った位置より前から抜ける = 時間が逆行する
      const got = gain?.(t.toTrackId) ?? 0;
      visitedSongs.add(song);
      trackTrail.push(t.toTrackId);
      trail.push(t);
      points += got;
      walk(t.toTrackId, time);
      points -= got;
      trail.pop();
      trackTrail.pop();
      visitedSongs.delete(song);
    }
  };
  walk(startId, enteredBy);
  return { ...best, truncated };
}

const songOfGraph = (g: Graph): SongOf => (id) => g.trackById.get(id)?.songId ?? id;

/** 繋ぎの時刻（入る・抜ける位置）を Graph から引く。`canFollow` の材料 */
export function graphTiming(g: Graph): (t: Transition) => Timing {
  const lookup = {
    bpm: (id: string) => g.trackById.get(id)?.bpm ?? null,
    cueMs: (id: string) => g.cueById.get(id)?.positionMs ?? null,
  };
  return (t) => timingOf(t, lookup);
}

/**
 * 探索結果の使い回し。`/`・`/play`・`/graph` は開くたびに**全曲ぶん**を探し直していて、
 * それだけで1秒以上かかっていた（実測 2026-09-25: 開発サーバで約1.5秒）。
 * 答えを決めるのは「曲の並びと songId」「繋ぎの並び・行き先・時刻」だけなので、
 * それが同じなら前回の答えを返す。Graph は要求ごとに作り直されるので、鍵は中身から作る。
 * 持つのは ID だけで、返すときに今の Graph の繋ぎへ引き直す（古い Graph の行を外へ出さない）。
 */
type RouteIds = { trackIds: string[]; edgeIds: string[] };
const routeCache = new Map<string, Map<string, RouteIds>>();
const ROUTE_CACHE_MAX = 4;
const signatures = new WeakMap<Graph, string>();

function routeSignature(g: Graph): string {
  let sig = signatures.get(g);
  if (sig !== undefined) return sig;
  const timing = graphTiming(g);
  const ts = g.tracks.map((t) => `${t.id}:${t.songId}`);
  const es: string[] = [];
  for (const t of g.tracks) {
    for (const e of g.outgoing.get(t.id) ?? []) {
      const { entryMs, exitMs } = timing(e);
      es.push(`${e.id}:${e.fromTrackId}>${e.toTrackId}@${entryMs}/${exitMs}`);
    }
  }
  sig = `${ts.join("\n")}\n--\n${es.join("\n")}`;
  signatures.set(g, sig);
  return sig;
}

export function longestRouteFrom(g: Graph, startId: string): Route {
  if (!g.trackById.has(startId)) return EMPTY;
  const sig = routeSignature(g);
  let memo = routeCache.get(sig);
  if (!memo) {
    if (routeCache.size >= ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value!);
    memo = new Map();
    routeCache.set(sig, memo);
  }
  let ids = memo.get(startId);
  if (!ids) {
    const r = walkLongest(g.outgoing, songOfGraph(g), startId, NOTHING_BLOCKED, MAX_STEPS, graphTiming(g));
    ids = { trackIds: r.trackIds, edgeIds: r.edges.map((e) => e.id) };
    memo.set(startId, ids);
  }
  const byId = transitionIndex(g);
  return { trackIds: ids.trackIds, transitions: ids.edgeIds.map((id) => byId.get(id)!) };
}

const indexes = new WeakMap<Graph, Map<string, Transition>>();
function transitionIndex(g: Graph): Map<string, Transition> {
  let m = indexes.get(g);
  if (!m) { m = new Map(g.transitions.map((t) => [t.id, t])); indexes.set(g, m); }
  return m;
}

/**
 * 「あと何曲つなげるか」だけを、**使った曲を外して**数え直す。
 *
 * `Graph`（server-only）を要らないので client からも呼べる。本番中に1タップごとに
 * 走るので打ち切りは浅い。`truncated` が立っていれば出た数は下限。
 * `blockedSongs` は曲ID ではなく songId（使った曲のリミックス違いも外すため）。
 */
export function maxOnwardFrom<E extends Step>(
  outgoing: ReadonlyMap<string, readonly E[]>,
  songOf: SongOf,
  startId: string,
  blockedSongs: ReadonlySet<string>,
  timing?: (e: E) => Timing,
  enteredBy: Timing | null = null,
): { count: number; truncated: boolean; trackIds: string[]; edges: E[] } {
  // 道筋も返す（何分のセットになるかを `lib/duration.ts` が数えるため）
  const r = walkLongest(outgoing, songOf, startId, blockedSongs, CLIENT_MAX_STEPS, timing, enteredBy);
  return { count: r.trackIds.length, truncated: r.truncated, trackIds: r.trackIds, edges: r.edges };
}

/** ライブラリ全体で最も長く繋げられる経路。 */
export function longestRouteOverall(g: Graph): Route {
  let best = EMPTY;
  for (const t of g.tracks) {
    const r = longestRouteFrom(g, t.id);
    if (r.trackIds.length > best.trackIds.length) best = r;
  }
  return best;
}

/**
 * **入れたい曲をなるべく多く通る道筋**（`/play/plan`）。
 *
 * 良さは「入れたい曲を何曲通るか → 同数なら全体の曲数が多い方」。間に他の曲を挟んでよいが、
 * **入れたい曲で始まり、入れたい曲で終わる**（頭や尻に他の曲だけを足した道は選ばない）。
 * 探索は `walkLongest` の1実装（同じ曲は2回かけない・時間が逆行する道は辿らない も同じ）。
 *
 * 「全体の曲数が多い方」は最長単純路そのもので、探し切れない（実データ85曲・162繋ぎで、
 * 300万歩でも終わらない組がある）。それに引きずられて入れたい曲を取りこぼしていた
 * （実測 2026-10-04: 18組中6組。8曲選んで7曲など）。そこで2段に分ける:
 *  1. **入れたい曲の数だけ**を最大にする。「ここから先でまだ届く入れたい曲」を数えて、
 *     足しても今の最良を超えなければその先は探さない（上界の枝刈り）。実データでは
 *     ほとんど数msで探し切れ、出た数が最大だと言える
 *  2. 残りの予算で、その数を保ったまま**全体の曲数**を伸ばす（1段目の最良から始める）
 * `truncated` は1段目が打ち切られたとき = 入れたい曲の数が最大とは言えないときだけ立つ。
 * 2段目の打ち切りは `lengthTruncated`（曲数はもっと伸びるかもしれない、というだけ）。
 */
const PLAN_MAX_STEPS = 300_000;
/** 1段目の時間の上限。端末で選ぶたびに回るので、画面を固めない長さにする */
const PLAN_STAGE1_MS = 1_500;
/** 2段目（長さを伸ばすだけ）の時間の上限 */
const PLAN_STAGE2_MS = 300;

export function planRoute<E extends Step>(
  outgoing: ReadonlyMap<string, readonly E[]>,
  songOf: SongOf,
  /** 入れたい曲（曲ID） */
  wanted: ReadonlySet<string>,
  timing?: (e: E) => Timing,
): { trackIds: string[]; edges: E[]; hits: number; truncated: boolean; lengthTruncated: boolean } {
  const starts = [...wanted].sort();
  if (starts.length === 0) return { trackIds: [], edges: [], hits: 0, truncated: false, lengthTruncated: false };
  const first = new Map<string, E[]>();
  for (const [id, list] of outgoing) {
    first.set(id, [...list].sort((a, b) => Number(wanted.has(b.toTrackId)) - Number(wanted.has(a.toTrackId))));
  }
  const gain = (id: string) => (wanted.has(id) ? 1 : 0);
  const canEnd = (id: string) => wanted.has(id);
  const wantedSongs = new Set(starts.map(songOf));

  /**
   * ここから先で、まだ通っていない曲を通って届く「入れたい曲」と「曲」の数（songId で数える）。
   * 時間の逆行は見ない = 実際より多めに数える。上界なのでそれで正しい。
   * 1歩ごとに呼ぶので、曲と曲（songId）を番号に直して配列で数える（Set で数えると数倍遅い）
   */
  const index = new Map<string, number>();
  const songIndex = new Map<string, number>();
  const ix = (id: string) => {
    let n = index.get(id);
    if (n === undefined) { n = index.size; index.set(id, n); }
    return n;
  };
  for (const [id, list] of first) { ix(id); for (const e of list) ix(e.toTrackId); }
  const songNo: number[] = [];
  const songName: string[] = [];
  for (const [id, n] of index) {
    const song = songOf(id);
    let sn = songIndex.get(song);
    if (sn === undefined) { sn = songIndex.size; songIndex.set(song, sn); songName.push(song); }
    songNo[n] = sn;
  }
  const adj: number[][] = [];
  for (const [id, n] of index) adj[n] = (first.get(id) ?? []).map((e) => index.get(e.toTrackId)!);
  const isWantedSong = songName.map((song) => wantedSongs.has(song));
  const seenTrack = new Uint32Array(index.size);
  const seenSong = new Uint32Array(songIndex.size);
  const blocked = new Uint32Array(songIndex.size);
  let stamp = 0;
  const stack: number[] = [];
  const reach = (from: string, visited: ReadonlySet<string>) => {
    stamp++;
    for (const song of visited) {
      const sn = songIndex.get(song);
      if (sn !== undefined) blocked[sn] = stamp;
    }
    const start = index.get(from);
    let wantedLeft = 0;
    let songsLeft = 0;
    if (start === undefined) return { wantedLeft, songsLeft };
    seenTrack[start] = stamp;
    stack.length = 0;
    stack.push(start);
    while (stack.length > 0) {
      for (const to of adj[stack.pop()!]) {
        if (seenTrack[to] === stamp) continue;
        const sn = songNo[to];
        if (blocked[sn] === stamp) continue;
        seenTrack[to] = stamp;
        if (seenSong[sn] !== stamp) {
          seenSong[sn] = stamp;
          songsLeft++;
          if (isWantedSong[sn]) wantedLeft++;
        }
        stack.push(to);
      }
    }
    return { wantedLeft, songsLeft };
  };

  type Best = { trackIds: string[]; edges: E[]; points: number };
  let best: Best = { trackIds: [], edges: [], points: 0 };
  const run = (opts: WalkOpts<E>, budget: number) => {
    let truncated = false;
    for (const start of starts) {
      const r = walkLongest(first, songOf, start, NOTHING_BLOCKED, budget, timing, null, gain, canEnd, {
        ...opts,
        seed: best.trackIds.length > 0 ? best : undefined,
      });
      truncated ||= r.truncated;
      if (r.points > best.points || (r.points === best.points && r.trackIds.length > best.trackIds.length)) {
        best = { trackIds: r.trackIds, edges: r.edges, points: r.points };
      }
    }
    return truncated;
  };

  // 1段目: 入れたい曲の数だけ。同数に届くだけの枝も探さない
  const budget = Math.max(2_000, Math.floor(PLAN_MAX_STEPS / starts.length));
  const truncated = run({
    deadline: performance.now() + PLAN_STAGE1_MS,
    prune: (id, visited, points, _len, b) => points + reach(id, visited).wantedLeft <= b.points,
  }, Number.MAX_SAFE_INTEGER);
  // 2段目: 同じ数のまま、全体の曲数を伸ばす
  const lengthTruncated = run({
    deadline: performance.now() + PLAN_STAGE2_MS,
    prune: (id, visited, points, len, b) => {
      const { wantedLeft, songsLeft } = reach(id, visited);
      if (points + wantedLeft < b.points) return true;
      return points + wantedLeft === b.points && len + songsLeft <= b.trackIds.length;
    },
  }, budget);
  return { trackIds: best.trackIds, edges: best.edges, hits: best.points, truncated, lengthTruncated };
}
