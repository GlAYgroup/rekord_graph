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
): { trackIds: string[]; edges: E[]; truncated: boolean } {
  let best: { trackIds: string[]; edges: E[] } = { trackIds: [startId], edges: [] };
  let steps = 0;
  let truncated = false;
  // 枝刈りは曲（songId）で、返す道筋は曲ID で持つ。混ぜると songId が曲ID として外へ漏れる
  const visitedSongs = new Set<string>([songOf(startId)]);
  const trackTrail: string[] = [startId];
  const trail: E[] = [];

  const walk = (nodeId: string) => {
    if (++steps > maxSteps) { truncated = true; return; }
    if (trackTrail.length > best.trackIds.length) {
      best = { trackIds: [...trackTrail], edges: [...trail] };
    }
    for (const t of outgoing.get(nodeId) ?? []) {
      const song = songOf(t.toTrackId);
      if (visitedSongs.has(song) || blockedSongs.has(song)) continue; // 同じ曲（リミックス違い含む）は2回かけない
      visitedSongs.add(song);
      trackTrail.push(t.toTrackId);
      trail.push(t);
      walk(t.toTrackId);
      trail.pop();
      trackTrail.pop();
      visitedSongs.delete(song);
    }
  };
  walk(startId);
  return { ...best, truncated };
}

const songOfGraph = (g: Graph): SongOf => (id) => g.trackById.get(id)?.songId ?? id;

export function longestRouteFrom(g: Graph, startId: string): Route {
  if (!g.trackById.has(startId)) return EMPTY;
  const r = walkLongest(g.outgoing, songOfGraph(g), startId, NOTHING_BLOCKED, MAX_STEPS);
  return { trackIds: r.trackIds, transitions: r.edges };
}

/**
 * 「あと何曲つなげるか」だけを、**使った曲を外して**数え直す。
 *
 * `Graph`（server-only）を要らないので client からも呼べる。本番中に1タップごとに
 * 走るので打ち切りは浅い。`truncated` が立っていれば出た数は下限。
 * `blockedSongs` は曲ID ではなく songId（使った曲のリミックス違いも外すため）。
 */
export function maxOnwardFrom(
  outgoing: ReadonlyMap<string, readonly Step[]>,
  songOf: SongOf,
  startId: string,
  blockedSongs: ReadonlySet<string>,
): { count: number; truncated: boolean } {
  const r = walkLongest(outgoing, songOf, startId, blockedSongs, CLIENT_MAX_STEPS);
  return { count: r.trackIds.length, truncated: r.truncated };
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
