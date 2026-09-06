import type { Graph, Transition } from "./graph";

/**
 * 「この曲から最大何曲つなげるか」を出す。
 *
 * 同じ曲を2回かけることはないので、**同じ曲を通らない経路（単純path）の最長**を探す。
 * 一般には NP困難だが、対象は数十ノード・数十エッジなので素直な全探索で十分。
 * 探索が爆発しないよう、訪問数に上限を置いて打ち切る。
 *
 * 本番中（/play）は「もう使った曲」を外して数え直す必要がある。そのため探索の本体は
 * `blocked` を取る形にして**ここ1箇所だけ**に置き、サーバ用（Graph を渡す）と
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

function walkLongest<E extends Step>(
  outgoing: ReadonlyMap<string, readonly E[]>,
  startId: string,
  blocked: ReadonlySet<string>,
  maxSteps: number,
): { trackIds: string[]; edges: E[]; truncated: boolean } {
  let best: { trackIds: string[]; edges: E[] } = { trackIds: [startId], edges: [] };
  let steps = 0;
  let truncated = false;
  const visited = new Set<string>([startId]);
  const trail: E[] = [];

  const walk = (nodeId: string) => {
    if (++steps > maxSteps) { truncated = true; return; }
    if (visited.size > best.trackIds.length) {
      best = { trackIds: [...visited], edges: [...trail] };
    }
    for (const t of outgoing.get(nodeId) ?? []) {
      if (visited.has(t.toTrackId) || blocked.has(t.toTrackId)) continue; // 同じ曲は2回かけない
      visited.add(t.toTrackId);
      trail.push(t);
      walk(t.toTrackId);
      trail.pop();
      visited.delete(t.toTrackId);
    }
  };
  walk(startId);
  return { ...best, truncated };
}

export function longestRouteFrom(g: Graph, startId: string): Route {
  if (!g.trackById.has(startId)) return EMPTY;
  const r = walkLongest(g.outgoing, startId, NOTHING_BLOCKED, MAX_STEPS);
  return { trackIds: r.trackIds, transitions: r.edges };
}

/**
 * 「あと何曲つなげるか」だけを、**使った曲を外して**数え直す。
 *
 * `Graph`（server-only）を要らないので client からも呼べる。本番中に1タップごとに
 * 走るので打ち切りは浅い。`truncated` が立っていれば出た数は下限。
 */
export function maxOnwardFrom(
  outgoing: ReadonlyMap<string, readonly Step[]>,
  startId: string,
  blocked: ReadonlySet<string>,
): { count: number; truncated: boolean } {
  const r = walkLongest(outgoing, startId, blocked, CLIENT_MAX_STEPS);
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
