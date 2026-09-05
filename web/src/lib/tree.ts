import { cueLabel } from "./format";
import type { Graph } from "./graph";
import { longestRouteFrom } from "./route";

/**
 * MixTree 風のツリー表示用データ。
 *
 * 起点の曲から outgoing を辿って右へ展開する。ネットワーク図と違い、
 * 同じ曲が複数の枝に別ノードとして現れてよい（「この経路で行くとここに出る」を
 * そのまま見せるのが目的）。ただし1本の経路内での再訪はしない（同じ曲は2回かけない）。
 *
 * レイアウトは古典的な tidy tree（葉を等間隔に置き、親は子の中央）。
 * 物理は使わない。ツリーは毎回同じ形であるべきなので決定的に計算する。
 *
 * 繋ぎのキュー（どのキューからどのキューへ）はカードではなく**線の上**に出す。
 * そのため列の間隔は固定ではなく、その列を通るラベルの最大幅に合わせて列ごとに広げる。
 */

export const CARD_W = 200;
export const CARD_H = 50; // 2行（曲名 / この先+BPM）。繋ぎは線上に出すのでカードは薄い
const Y_GAP = 16;
const MIN_X_GAP = 72;
/** 線上ラベルの mono フォントサイズ。TreeMixView の描画と合わせること */
const LABEL_FONT_PX = 10.5;
/** ラベルの左右に確保する余白（両側の合計）。unitsOf の見積り誤差もここで吸収する */
const LABEL_PAD = 32;
const MAX_DEPTH = 12;  // これを超えて枝が続く場合は truncated を立てて UI に知らせる
const MAX_NODES = 400; // 暴走防止。現実のデータでは届かない

export type TreeCard = {
  uid: string;          // エッジ経路で一意。同じ曲ペアに複数の繋ぎがあっても衝突しない
  trackId: string;
  name: string;
  bpm: number | null;
  musicalKey: string;
  depth: number;
  x: number;
  y: number;
  onRoute: boolean;     // 起点からの最長ルート上にあるか
  maxFrom: number;      // この曲からさらに最大何曲行けるか（曲自身を含む）
  /** 親からこのカードへ入る繋ぎ。ルートには無い。線上ラベルはここから組み立てる */
  via?: { fromCue: string; toCue: string; comment: string; bars: number | null };
};

export type TreeLink = { id: string; from: string; to: string; onRoute: boolean };

export type TreeData = {
  rootId: string;
  cards: TreeCard[];
  links: TreeLink[];
  width: number;
  height: number;
  truncated: boolean;
};

/** 全角=1・半角=0.6 で数えた表示幅の見積り（単位: 全角文字数） */
function unitsOf(text: string): number {
  let units = 0;
  for (let i = 0; i < text.length; i++) units += text.charCodeAt(i) > 0xff ? 1 : 0.6;
  return units;
}

type BuildNode = {
  uid: string;      // ルートtrackId + エッジIDの連結。平行エッジ（同じ曲ペアに複数の繋ぎ）でも一意
  routeKey: string; // trackId の経路。最長ルート上かの判定に使う
  trackId: string;
  depth: number;
  children: BuildNode[];
  edgeId?: string;
};

export function buildTree(g: Graph, rootId: string): TreeData | null {
  if (!g.trackById.has(rootId)) return null;

  let count = 0;
  let truncated = false;

  const grow = (trackId: string, parentUid: string, path: string[], depth: number, edgeId?: string): BuildNode => {
    const uid = parentUid ? `${parentUid}|${edgeId}` : trackId;
    const node: BuildNode = {
      uid, trackId, depth, children: [], edgeId,
      routeKey: [...path, trackId].join(">"),
    };
    count++;
    const expandable = (g.outgoing.get(trackId) ?? []).filter(
      (t) => !path.includes(t.toTrackId) && t.toTrackId !== trackId, // 同じ曲は2回かけない
    );
    if (depth >= MAX_DEPTH || count > MAX_NODES) {
      if (expandable.length > 0) truncated = true; // 続きがあるのに黙って切るのは嘘になる
      return node;
    }
    for (const t of expandable) {
      node.children.push(grow(t.toTrackId, uid, [...path, trackId], depth + 1, t.id));
    }
    return node;
  };
  const root = grow(rootId, "", [], 0);

  // 繋ぎのキューを先に解決し、列ごとに「線上ラベルの最大幅」を集める。
  // ラベルは `From→` と `To` の2行で線の中央に出るので、列間はその幅に合わせて広げる
  const viaOf = new Map<string, NonNullable<TreeCard["via"]>>();
  const labelUnitsAt = new Map<number, number>(); // 親の depth → その列間を通るラベルの最大行ユニット
  let maxDepth = 0;
  const prep = (n: BuildNode) => {
    maxDepth = Math.max(maxDepth, n.depth);
    if (n.edgeId) {
      const edge = g.transitions.find((t) => t.id === n.edgeId);
      if (edge) {
        const via = {
          fromCue: cueLabel(g.cueById.get(edge.fromCueId)),
          toCue: cueLabel(g.cueById.get(edge.toCueId)),
          comment: edge.comment,
          bars: edge.bars,
        };
        viaOf.set(n.uid, via);
        const u = Math.max(unitsOf(`${via.fromCue}→`), unitsOf(via.toCue));
        const d = n.depth - 1;
        labelUnitsAt.set(d, Math.max(labelUnitsAt.get(d) ?? 0, u));
      }
    }
    for (const c of n.children) prep(c);
  };
  prep(root);

  // 列の左端 x。列間 = その列を通るラベルの最大幅 + 余白（ラベルが無い列は最小値）
  const xs: number[] = [0];
  for (let d = 0; d < maxDepth; d++) {
    const labelW = (labelUnitsAt.get(d) ?? 0) * LABEL_FONT_PX;
    xs.push(xs[d] + CARD_W + Math.max(MIN_X_GAP, Math.ceil(labelW) + LABEL_PAD));
  }

  // tidy tree: 葉から順に縦位置を割り当て、親は子の中央に置く
  let leafCursor = 0;
  const yUnit = CARD_H + Y_GAP;
  const yOf = new Map<string, number>();
  const assign = (n: BuildNode): number => {
    if (n.children.length === 0) {
      const y = leafCursor++ * yUnit;
      yOf.set(n.uid, y);
      return y;
    }
    const ys = n.children.map(assign);
    const y = (Math.min(...ys) + Math.max(...ys)) / 2;
    yOf.set(n.uid, y);
    return y;
  };
  assign(root);

  // 最長ルートの経路上かどうか（routeKey = trackId 経路のプレフィックス一致）
  const route = longestRouteFrom(g, rootId).trackIds;
  const routeKeys = new Set(route.map((_, i) => route.slice(0, i + 1).join(">")));

  const cards: TreeCard[] = [];
  const links: TreeLink[] = [];
  const walk = (n: BuildNode) => {
    const track = g.trackById.get(n.trackId);
    cards.push({
      uid: n.uid,
      trackId: n.trackId,
      name: track?.name ?? "?",
      bpm: track?.bpm ?? null,
      musicalKey: track?.musicalKey ?? "",
      depth: n.depth,
      x: xs[n.depth],
      y: yOf.get(n.uid) ?? 0,
      onRoute: routeKeys.has(n.routeKey),
      maxFrom: longestRouteFrom(g, n.trackId).trackIds.length,
      via: viaOf.get(n.uid),
    });
    for (const c of n.children) {
      links.push({ id: c.uid, from: n.uid, to: c.uid, onRoute: routeKeys.has(c.routeKey) && routeKeys.has(n.routeKey) });
      walk(c);
    }
  };
  walk(root);

  return {
    rootId,
    cards,
    links,
    width: xs[maxDepth] + CARD_W,
    height: Math.max(CARD_H, leafCursor * yUnit - Y_GAP),
    truncated,
  };
}
