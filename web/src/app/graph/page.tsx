import { GraphExplorer } from "@/components/graph/GraphExplorer";
import { TreeMixView } from "@/components/graph/TreeMixView";
import type { GEdge, GNode, PanelData, RouteMap } from "@/components/graph/types";
import { bpmDelta, cueLabel } from "@/lib/format";
import { getGraph } from "@/lib/graph";
import { computeLayout } from "@/lib/layout";
import { listPatterns } from "@/lib/patterns";
import { longestRouteFrom, longestRouteOverall } from "@/lib/route";
import { buildTree } from "@/lib/tree";

export const metadata = { title: "グラフ | rekord_graph" };

export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const from = typeof sp.from === "string" ? sp.from : undefined;
  const g = await getGraph();

  // ツリーモード: 起点から右へ分岐を展開する（MixTree 風）
  if (sp.mode === "tree") {
    const rootId =
      (typeof sp.root === "string" && g.trackById.has(sp.root) && sp.root) ||
      (from && g.trackById.has(from) && from) ||
      longestRouteOverall(g).trackIds[0];
    const tree = rootId ? buildTree(g, rootId) : null;
    if (tree) {
      // 起点は全曲から選べる。先の長い曲ほど起点として面白いので上に出す
      const rootOptions = g.tracks
        .map((t) => ({ id: t.id, name: t.name, maxFrom: longestRouteFrom(g, t.id).trackIds.length }))
        .sort((a, b) => b.maxFrom - a.maxFrom || a.name.localeCompare(b.name, "ja"));
      return (
        <TreeMixView
          tree={tree}
          rootName={g.trackById.get(tree.rootId)?.name ?? "?"}
          rootOptions={rootOptions}
        />
      );
    }
  }

  // 曲ごとの最長ルートをサーバで前計算しておく（クライアントは表示に専念）
  const routes: RouteMap = {};
  for (const t of g.tracks) {
    const r = longestRouteFrom(g, t.id);
    routes[t.id] = { trackIds: r.trackIds, edgeIds: r.transitions.map((x) => x.id) };
  }
  const overall = longestRouteOverall(g);

  const nodes: GNode[] = g.tracks.map((t) => ({
    id: t.id,
    rbId: t.rekordboxId,
    name: t.name,
    bpm: t.bpm,
    musicalKey: t.musicalKey,
    out: g.outgoing.get(t.id)?.length ?? 0,
    in: g.incoming.get(t.id)?.length ?? 0,
    maxFrom: routes[t.id].trackIds.length,
  }));

  const edges: GEdge[] = g.transitions.map((t) => ({
    id: t.id, source: t.fromTrackId, target: t.toTrackId,
  }));

  const panel: PanelData = {};
  for (const t of g.tracks) panel[t.id] = { out: [], in: [] };
  for (const t of g.transitions) {
    const item = {
      id: t.id,
      // ループの印は文字列に焼き込む（パネルは組み立て済みの文字列だけを受け取る）
      fromCue: cueLabel(g.cueById.get(t.fromCueId)),
      toCue: cueLabel(g.cueById.get(t.toCueId)),
      comment: t.comment,
      rating: t.rating,
      practice: t.practice,
      technique: t.technique,
      bars: t.bars,
      barsAfter: t.barsAfter,
    };
    const to = g.trackById.get(t.toTrackId);
    const from = g.trackById.get(t.fromTrackId);
    panel[t.fromTrackId]?.out.push({
      ...item, otherId: t.toTrackId, otherName: to?.name ?? "?", otherBpm: to?.bpm ?? null,
      otherMaxFrom: routes[t.toTrackId]?.trackIds.length ?? 1,
    });
    panel[t.toTrackId]?.in.push({
      ...item, otherId: t.fromTrackId, otherName: from?.name ?? "?", otherBpm: from?.bpm ?? null,
      otherMaxFrom: routes[t.fromTrackId]?.trackIds.length ?? 1,
    });
  }
  // 並びは「その曲から先につなげる曲数」が多い順 = /play の一覧と同じ問いに同じ答えを出す。
  // 同数ならテンポの近い順（ピッチを触らずに済むものから）→ 曲名 → ID
  // （同じ選択で毎回同じ並びになるように、最後は必ず一意なもので決める）
  for (const id of Object.keys(panel)) {
    const bpm = g.trackById.get(id)?.bpm ?? null;
    const near = (b: number | null) => Math.abs(bpmDelta(bpm, b) ?? 999);
    for (const dir of ["out", "in"] as const) {
      panel[id][dir].sort(
        (a, b) =>
          b.otherMaxFrom - a.otherMaxFrom ||
          near(a.otherBpm) - near(b.otherBpm) ||
          a.otherName.localeCompare(b.otherName, "ja") ||
          a.id.localeCompare(b.id),
      );
    }
  }

  const connected = new Set(g.transitions.flatMap((t) => [t.fromTrackId, t.toTrackId]));

  // 配置はサーバで決める。端末ごとに計算すると誤差で形がズレるため、座標を渡す方が正しい
  const layout = computeLayout(nodes.map((n) => ({ id: n.id, label: n.name })), edges);

  // 保存済みパターン。先頭（最後に保存したもの）を既定の形として開く。
  // Notion が落ちていても地図は出したいので、失敗しても素の配置で続行する
  const patterns = await listPatterns().catch(() => []);

  return (
    <GraphExplorer
      nodes={nodes}
      edges={edges}
      layout={layout}
      patterns={patterns}
      routes={routes}
      overallRoute={{ trackIds: overall.trackIds, edgeIds: overall.transitions.map((t) => t.id) }}
      panel={panel}
      initialFocusId={from}
      stats={{
        connected: connected.size,
        transitions: g.transitions.length,
        longest: overall.trackIds.length,
      }}
    />
  );
}
