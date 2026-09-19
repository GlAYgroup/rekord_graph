import { barsLabel, cueLabel, type BarsLike } from "./format";
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
 * ★ この画面はプレイ中に見る。**文字を省略しない**のが最優先。
 *
 *  - 曲名は刈らずに折り返す（カードの高さが1枚ごとに変わる）
 *  - 繋ぎの情報（キュー・小節数・テクニック・メモ）は**全文**を線の上に出す。
 *    メモが長ければ行が増え、その分だけ列の間隔と行の間隔をサーバが広げる
 *  - 折り返しはここ（サーバ）で確定させ、画面はその行をそのまま描くだけにする。
 *    測る場所と描く場所が分かれていると、必ずどちらかがはみ出す
 *
 * 繋ぎのラベルは**線の中点ではなく行き先カードの真横**に置く。中点だと
 * 兄弟同士の間隔が行間隔の半分になり、複数行のラベルが必ず重なる。
 */

/** カードの幅。曲名を折り返して収めるので、点の図より広くとる */
export const CARD_W = 280;
const CARD_PAD_X = 12;
const CARD_PAD_TOP = 9;
const CARD_PAD_BOTTOM = 8;
/** 曲名の文字サイズ・行送り。TreeMixView の <text> と一致させること */
export const NAME_FONT_PX = 13;
export const NAME_LINE_H = 17;
/** 曲名の下の1行（起点 / この先何曲 / BPM） */
export const META_LINE_H = 17;

/** 線上ラベルの文字サイズ・行送り。TreeMixView の描画と合わせること */
export const LABEL_FONT_PX = 11;
export const LABEL_LINE_H = 15;
/** ラベルの背景箱の内側の余白 */
export const LABEL_PAD_X = 9;
export const LABEL_PAD_Y = 7;
/** ラベル1行の最大幅（全角=1 の単位）。これを超えたら折り返す。**省略はしない** */
const LABEL_MAX_UNITS = 20;
/** ラベルとカードの間に空ける余白（両側の合計） */
const LABEL_MARGIN_X = 28;

const Y_GAP = 20;
const MIN_X_GAP = 72;
const MAX_DEPTH = 12;  // これを超えて枝が続く場合は truncated を立てて UI に知らせる
const MAX_NODES = 400; // 暴走防止。現実のデータでは届かない

/** ラベル1行。種類ごとに色を変えるので、文字列だけでなく用途も持たせる */
export type ViaLine = { text: string; kind: "cue" | "bars" | "tech" | "memo" };

export type TreeVia = {
  fromCue: string;
  toCue: string;
  comment: string;
  bars: number | null;
  barsAfter: number | null;
  technique: string | null;
  /** 描く行（折り返し済み）。画面はこれをそのまま出す */
  lines: ViaLine[];
  /** 背景箱の位置と大きさ。y はカードの縦中心を基準に上下対称に置く */
  x: number;
  w: number;
  h: number;
};

export type TreeCard = {
  uid: string;          // エッジ経路で一意。同じ曲ペアに複数の繋ぎがあっても衝突しない
  trackId: string;
  name: string;
  /** 折り返し済みの曲名。**刈らない** */
  nameLines: string[];
  bpm: number | null;
  musicalKey: string;
  depth: number;
  x: number;
  y: number;
  /** カードの高さ。曲名の行数で変わる */
  h: number;
  onRoute: boolean;     // 起点からの最長ルート上にあるか
  maxFrom: number;      // この曲からさらに最大何曲行けるか（曲自身を含む）
  /** 親からこのカードへ入る繋ぎ。ルートには無い。ラベルはこのカードの左横に出る */
  via?: TreeVia;
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

/**
 * 見積りに掛ける安全率。
 *
 * 実測（Chrome / 実データ 148ノード）で、実際の描画幅は unitsOf の見積りの
 * 最大 1.06倍（mono の線上ラベル）・1.21倍（sans の大文字だけの曲名 `HERO`）だった。
 * 文字ごとに係数を持たせるより、幅の計算にだけ一律の安全率を掛ける方が壊れにくい。
 * 折り返しの閾値（units）はそのままなので、**箱は必ず文字より広い**。
 */
const WIDTH_SAFETY = 1.25;

/** 全角=1・半角=0.6 で数えた表示幅の見積り（単位: 全角文字数）。
    半角を 0.5 で数えると英字主体の曲名が枠線まで達する（実測 0.6 文字分）。
    実寸に直すときは必ず WIDTH_SAFETY を掛ける */
function unitsOf(text: string): number {
  let units = 0;
  for (let i = 0; i < text.length; i++) units += text.charCodeAt(i) > 0xff ? 1 : 0.6;
  return units;
}

/**
 * 折り返す。**1文字も削らない**（省略記号は使わない）。
 * 空白で切れるならそこで、切れない長い塊は幅で強制的に折る。
 */
export function wrapUnits(text: string, maxUnits: number): string[] {
  const words = text.split(/(\s+)/).filter((w) => w !== "");
  const lines: string[] = [];
  let line = "";

  const pushHard = (chunk: string) => {
    let cur = "";
    for (const ch of chunk) {
      if (unitsOf(cur + ch) > maxUnits && cur) { lines.push(cur); cur = ""; }
      cur += ch;
    }
    line = cur;
  };

  for (const w of words) {
    const candidate = line + w;
    if (unitsOf(candidate) <= maxUnits) { line = candidate; continue; }
    if (line.trim()) { lines.push(line.trim()); line = ""; }
    if (unitsOf(w) > maxUnits) pushHard(w.trim());
    else line = w.trim();
  }
  if (line.trim()) lines.push(line.trim());
  return lines.length ? lines : [text];
}

/** カード内で曲名に使える幅（全角=1 の単位） */
const NAME_MAX_UNITS = (CARD_W - CARD_PAD_X * 2) / (NAME_FONT_PX * WIDTH_SAFETY);

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
  const songOf = (id: string) => g.trackById.get(id)?.songId ?? id;

  const grow = (trackId: string, parentUid: string, path: string[], depth: number, edgeId?: string): BuildNode => {
    const uid = parentUid ? `${parentUid}|${edgeId}` : trackId;
    const node: BuildNode = {
      uid, trackId, depth, children: [], edgeId,
      routeKey: [...path, trackId].join(">"),
    };
    count++;
    // 同じ曲は2回かけない。リミックス違いも同じ曲（songId で比べる）
    const songsSoFar = new Set([...path, trackId].map(songOf));
    const expandable = (g.outgoing.get(trackId) ?? []).filter(
      (t) => !songsSoFar.has(songOf(t.toTrackId)),
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

  /** 繋ぎ1本を「読める行の並び」に開く。**メモは省略しない** */
  const viaLinesOf = (fromCue: string, toCue: string, technique: string | null, bars: BarsLike, comment: string): ViaLine[] => {
    const lines: ViaLine[] = [];
    for (const t of wrapUnits(`${fromCue} →`, LABEL_MAX_UNITS)) lines.push({ text: t, kind: "cue" });
    for (const t of wrapUnits(toCue, LABEL_MAX_UNITS)) lines.push({ text: t, kind: "cue" });
    if (technique) for (const t of wrapUnits(technique, LABEL_MAX_UNITS)) lines.push({ text: t, kind: "tech" });
    // 小節数は「次の曲のキューの何小節前／後か」。短縮すると逆向きに読めるので barsLabel をそのまま出す
    const bl = barsLabel(bars, toCue);
    if (bl) for (const t of wrapUnits(bl, LABEL_MAX_UNITS)) lines.push({ text: t, kind: "bars" });
    if (comment) for (const t of wrapUnits(comment, LABEL_MAX_UNITS)) lines.push({ text: t, kind: "memo" });
    return lines;
  };

  // 繋ぎを先に解決し、列ごとに「ラベルの最大幅」を集める。列間はその幅に合わせて広げる
  type Draft = Omit<TreeVia, "x">;
  const viaOf = new Map<string, Draft>();
  const labelWAt = new Map<number, number>(); // 親の depth → その列間に出るラベルの最大幅(px)
  let maxDepth = 0;
  const prep = (n: BuildNode) => {
    maxDepth = Math.max(maxDepth, n.depth);
    if (n.edgeId) {
      const edge = g.transitions.find((t) => t.id === n.edgeId);
      if (edge) {
        const fromCue = cueLabel(g.cueById.get(edge.fromCueId));
        const toCue = cueLabel(g.cueById.get(edge.toCueId));
        const lines = viaLinesOf(fromCue, toCue, edge.technique, edge, edge.comment);
        const w = Math.ceil(Math.max(...lines.map((l) => unitsOf(l.text))) * LABEL_FONT_PX * WIDTH_SAFETY) + LABEL_PAD_X * 2;
        const h = lines.length * LABEL_LINE_H + LABEL_PAD_Y * 2;
        viaOf.set(n.uid, {
          fromCue, toCue, comment: edge.comment,
          bars: edge.bars, barsAfter: edge.barsAfter, technique: edge.technique, lines, w, h,
        });
        const d = n.depth - 1;
        labelWAt.set(d, Math.max(labelWAt.get(d) ?? 0, w));
      }
    }
    for (const c of n.children) prep(c);
  };
  prep(root);

  // 列の左端 x。列間 = その列に出るラベルの最大幅 + 余白（ラベルが無い列は最小値）
  const xs: number[] = [0];
  for (let d = 0; d < maxDepth; d++) {
    const labelW = labelWAt.get(d) ?? 0;
    xs.push(xs[d] + CARD_W + Math.max(MIN_X_GAP, labelW + LABEL_MARGIN_X));
  }

  // カードの高さ（曲名の行数で変わる）と、行として占める高さ（ラベルの方が高いことがある）
  const nameLinesOf = new Map<string, string[]>();
  const cardHOf = new Map<string, number>();
  const rowHOf = new Map<string, number>();
  const measure = (n: BuildNode) => {
    const track = g.trackById.get(n.trackId);
    const lines = wrapUnits(track?.name ?? "?", NAME_MAX_UNITS);
    const cardH = CARD_PAD_TOP + lines.length * NAME_LINE_H + META_LINE_H + CARD_PAD_BOTTOM;
    nameLinesOf.set(n.uid, lines);
    cardHOf.set(n.uid, cardH);
    rowHOf.set(n.uid, Math.max(cardH, viaOf.get(n.uid)?.h ?? 0));
    for (const c of n.children) measure(c);
  };
  measure(root);

  // tidy tree: 葉から順に縦位置（中心）を割り当て、親は子の中央に置く
  let cursor = 0;
  const centerOf = new Map<string, number>();
  const assign = (n: BuildNode): number => {
    if (n.children.length === 0) {
      const h = rowHOf.get(n.uid)!;
      const c = cursor + h / 2;
      cursor += h + Y_GAP;
      centerOf.set(n.uid, c);
      return c;
    }
    const cs = n.children.map(assign);
    const c = (Math.min(...cs) + Math.max(...cs)) / 2;
    centerOf.set(n.uid, c);
    return c;
  };
  assign(root);

  // 親の方が子の並びより背が高いと、同じ列の隣と重なりうる。列ごとに下へ押して解く。
  // 並べ替えのキーに uid を混ぜて、同じ中心のときも順番が毎回同じになるようにする
  const byDepth = new Map<number, BuildNode[]>();
  const collect = (n: BuildNode) => {
    const list = byDepth.get(n.depth) ?? [];
    list.push(n);
    byDepth.set(n.depth, list);
    for (const c of n.children) collect(c);
  };
  collect(root);
  for (const list of byDepth.values()) {
    const sorted = [...list].sort(
      (a, b) => (centerOf.get(a.uid)! - centerOf.get(b.uid)!) || a.uid.localeCompare(b.uid),
    );
    let bottom = -Infinity;
    for (const n of sorted) {
      const h = rowHOf.get(n.uid)!;
      const top = Math.max(centerOf.get(n.uid)! - h / 2, bottom + Y_GAP);
      centerOf.set(n.uid, top + h / 2);
      bottom = top + h;
    }
  }

  // 最長ルートの経路上かどうか（routeKey = trackId 経路のプレフィックス一致）
  const route = longestRouteFrom(g, rootId).trackIds;
  const routeKeys = new Set(route.map((_, i) => route.slice(0, i + 1).join(">")));

  const cards: TreeCard[] = [];
  const links: TreeLink[] = [];
  const walk = (n: BuildNode) => {
    const track = g.trackById.get(n.trackId);
    const cardH = cardHOf.get(n.uid)!;
    const draft = viaOf.get(n.uid);
    const x = xs[n.depth];
    cards.push({
      uid: n.uid,
      trackId: n.trackId,
      name: track?.name ?? "?",
      nameLines: nameLinesOf.get(n.uid)!,
      bpm: track?.bpm ?? null,
      musicalKey: track?.musicalKey ?? "",
      depth: n.depth,
      x,
      y: centerOf.get(n.uid)! - cardH / 2,
      h: cardH,
      onRoute: routeKeys.has(n.routeKey),
      maxFrom: longestRouteFrom(g, n.trackId).trackIds.length,
      // ラベルは行き先カードの左横、親との隙間の中央に置く
      via: draft
        ? { ...draft, x: (xs[n.depth - 1] + CARD_W + x) / 2 - draft.w / 2 }
        : undefined,
    });
    for (const c of n.children) {
      links.push({ id: c.uid, from: n.uid, to: c.uid, onRoute: routeKeys.has(c.routeKey) && routeKeys.has(n.routeKey) });
      walk(c);
    }
  };
  walk(root);

  // ラベルはカードより背が高いことがあるので、上下端はラベルも含めて測る
  let top = Infinity;
  let bottom = -Infinity;
  for (const c of cards) {
    const cy = c.y + c.h / 2;
    top = Math.min(top, c.y, c.via ? cy - c.via.h / 2 : c.y);
    bottom = Math.max(bottom, c.y + c.h, c.via ? cy + c.via.h / 2 : c.y + c.h);
  }
  for (const c of cards) c.y -= top;

  return {
    rootId,
    cards,
    links,
    width: xs[maxDepth] + CARD_W,
    height: Math.max(1, bottom - top),
    truncated,
  };
}
