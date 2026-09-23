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
): { trackIds: string[]; edges: E[]; truncated: boolean; points: number } {
  let best: { trackIds: string[]; edges: E[]; points: number } = {
    trackIds: [startId], edges: [], points: gain?.(startId) ?? 0,
  };
  let points = best.points;
  let steps = 0;
  let truncated = false;
  // 枝刈りは曲（songId）で、返す道筋は曲ID で持つ。混ぜると songId が曲ID として外へ漏れる
  const visitedSongs = new Set<string>([songOf(startId)]);
  const trackTrail: string[] = [startId];
  const trail: E[] = [];

  const walk = (nodeId: string, entered: Timing | null) => {
    if (++steps > maxSteps) { truncated = true; return; }
    const better = points > best.points || (points === best.points && trackTrail.length > best.trackIds.length);
    if (better && (!canEnd || canEnd(nodeId))) {
      best = { trackIds: [...trackTrail], edges: [...trail], points };
    }
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

export function longestRouteFrom(g: Graph, startId: string): Route {
  if (!g.trackById.has(startId)) return EMPTY;
  const r = walkLongest(g.outgoing, songOfGraph(g), startId, NOTHING_BLOCKED, MAX_STEPS, graphTiming(g));
  return { trackIds: r.trackIds, transitions: r.edges };
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
 * 入れたい曲が全部入った後も「もっと長い道」を探し続けるので、打ち切りに当たりやすい。
 * 打ち切っても良い答えが先に見つかるよう、**入れたい曲へ向かう繋ぎから先に試す**。
 * `truncated` が立っていれば、出た道は「少なくともこれだけ入る」。
 */
const PLAN_MAX_STEPS = 300_000;

export function planRoute<E extends Step>(
  outgoing: ReadonlyMap<string, readonly E[]>,
  songOf: SongOf,
  /** 入れたい曲（曲ID） */
  wanted: ReadonlySet<string>,
  timing?: (e: E) => Timing,
): { trackIds: string[]; edges: E[]; hits: number; truncated: boolean } {
  const starts = [...wanted].sort();
  if (starts.length === 0) return { trackIds: [], edges: [], hits: 0, truncated: false };
  const first = new Map<string, E[]>();
  for (const [id, list] of outgoing) {
    first.set(id, [...list].sort((a, b) => Number(wanted.has(b.toTrackId)) - Number(wanted.has(a.toTrackId))));
  }
  const gain = (id: string) => (wanted.has(id) ? 1 : 0);
  const canEnd = (id: string) => wanted.has(id);
  const budget = Math.max(2_000, Math.floor(PLAN_MAX_STEPS / starts.length));
  let best = { trackIds: [] as string[], edges: [] as E[], hits: 0 };
  let truncated = false;
  for (const start of starts) {
    const r = walkLongest(first, songOf, start, NOTHING_BLOCKED, budget, timing, null, gain, canEnd);
    truncated ||= r.truncated;
    if (r.points > best.hits || (r.points === best.hits && r.trackIds.length > best.trackIds.length)) {
      best = { trackIds: r.trackIds, edges: r.edges, hits: r.points };
    }
  }
  return { ...best, truncated };
}
