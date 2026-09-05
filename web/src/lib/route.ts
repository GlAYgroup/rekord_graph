import type { Graph, Transition } from "./graph";

/**
 * 「この曲から最大何曲つなげるか」を出す。
 *
 * 同じ曲を2回かけることはないので、**同じ曲を通らない経路（単純path）の最長**を探す。
 * 一般には NP困難だが、対象は数十ノード・数十エッジなので素直な全探索で十分。
 * 探索が爆発しないよう、訪問数に上限を置いて打ち切る。
 */

export type Route = { trackIds: string[]; transitions: Transition[] };

const EMPTY: Route = { trackIds: [], transitions: [] };
const MAX_STEPS = 200_000; // 打ち切り。現実のデータでは到達しない

export function longestRouteFrom(g: Graph, startId: string): Route {
  if (!g.trackById.has(startId)) return EMPTY;

  let best: Route = { trackIds: [startId], transitions: [] };
  let steps = 0;
  const visited = new Set<string>([startId]);
  const trail: Transition[] = [];

  const walk = (nodeId: string) => {
    if (++steps > MAX_STEPS) return;
    if (visited.size > best.trackIds.length) {
      best = { trackIds: [...visited], transitions: [...trail] };
    }
    for (const t of g.outgoing.get(nodeId) ?? []) {
      if (visited.has(t.toTrackId)) continue; // 同じ曲は2回かけない
      visited.add(t.toTrackId);
      trail.push(t);
      walk(t.toTrackId);
      trail.pop();
      visited.delete(t.toTrackId);
    }
  };
  walk(startId);
  return best;
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
