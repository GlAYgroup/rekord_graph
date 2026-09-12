/**
 * グラフの配置計算。**サーバで回してクライアントへ座標を渡す**ためのモジュール。
 *
 * なぜサーバか: 配置をブラウザ側で計算していた頃、スマホと PC で形が違っていた。
 * 原因は3つあって、どれもクライアント計算をやめると同時に消える。
 *
 *  1. 保存先が localStorage だった → 端末ごとに別の形が育つ（これが主因）
 *  2. 初回に開いた時点の曲数で収束する → 開いた日が違えば形が違う
 *  3. 力学計算は誤差が増幅する → iOS(JavaScriptCore) と Chrome(V8) で
 *     数式の丸めが 1ULP 違うだけで、400 ステップ後には別の谷に落ちうる
 *
 * したがってここは「同じ入力なら必ず同じ座標」でなければならない。そのための約束:
 *  - 計算対象は **id 昇順に並べ替えてから**回す。浮動小数の加算は順序を変えると
 *    結果が変わるので、Notion の行順や表示名の並びに配置が引きずられないようにする
 *  - `Math.hypot` は使わず `Math.sqrt` を使う。hypot は仕様上の丸め精度が
 *    処理系依存で、環境差の入口になる（sqrt は IEEE754 で正確丸めが保証される）
 *
 * ★ 配置の方針（曲名を省略せず全文出すようになってからの版）
 *
 *  - ノードは点ではなく **ラベルを含めた箱** として扱う。曲名が長いので、
 *    点として詰めると必ず文字が重なる。箱同士の重なりを解く工程を必ず通す
 *  - **繋ぎのある曲だけで力学を回す。** 繋ぎの無い曲（現状 37曲）を混ぜると、
 *    見たい構造が端に押しやられる。孤立曲は解いたあとで下に整列させる
 *
 * クライアントからも import される（純粋な計算だけ。server-only にしないこと）。
 */

export type Sim = { id: string; x: number; y: number; vx: number; vy: number; pinned?: boolean };

/** 曲ID -> 画面座標。サーバが決めた「正」の形 */
export type Layout = Record<string, { x: number; y: number }>;

type LayoutNode = { id: string; label?: string };
type LayoutEdge = { id?: string; source: string; target: string };

const REPULSION = 26000;
const SPRING_LENGTH = 230; // ラベルの幅ぶん、点だけのときより長くとる
const SPRING_K = 0.05;
const GRAVITY = 0.03;
const DAMPING = 0.82;
const ITERATIONS = 500;

/* ---------- ラベルの寸法（クライアントの描画と必ず同じ規則にする） ---------- */

/** ラベルの文字サイズ。GraphExplorer の <text fontSize> と一致させること */
export const LABEL_FONT = 11.5;
/** 行送り */
export const LABEL_LINE_H = 13;
/** 1行の最大幅（全角=1 の単位）。これを超えたら折り返す。**省略はしない** */
export const LABEL_MAX_UNITS = 15;
/** ノードの円の最大半径（GraphExplorer の radius() の上限と合わせる） */
const NODE_R = 17;
/** 箱同士のすき間 */
const GAP_X = 14;
const GAP_Y = 10;

/** 全角=1・半角=0.5 で数えた表示幅 */
function units(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) > 0xff ? 1 : 0.5;
  return n;
}

/**
 * ラベルを折り返す。**1文字も削らない**（省略記号は使わない方針）。
 * 空白で切れるならそこで、切れない長い塊は幅で強制的に折る。
 */
export function wrapLabel(text: string, maxUnits: number = LABEL_MAX_UNITS): string[] {
  const words = text.split(/(\s+)/).filter((w) => w !== "");
  const lines: string[] = [];
  let line = "";

  const pushHard = (chunk: string) => {
    // 空白の無い長い塊。幅で強制的に折る
    let cur = "";
    for (const ch of chunk) {
      if (units(cur + ch) > maxUnits && cur) { lines.push(cur); cur = ""; }
      cur += ch;
    }
    line = cur;
  };

  for (const w of words) {
    const candidate = line + w;
    if (units(candidate) <= maxUnits) { line = candidate; continue; }
    if (line.trim()) { lines.push(line.trim()); line = ""; }
    if (units(w) > maxUnits) pushHard(w.trim());
    else line = w.trim();
  }
  if (line.trim()) lines.push(line.trim());
  return lines.length ? lines : [text];
}

/** ラベルの表示幅（px）。fit（全体表示）で端が切れないようにするために使う */
export function labelWidth(text: string): number {
  return Math.max(...wrapLabel(text).map(units)) * LABEL_FONT;
}

/** ノードが画面で占める箱。中心は円の中心ではなく、ラベルを含めた重心にする */
function boxOf(n: LayoutNode): { w: number; h: number; dy: number } {
  const lines = wrapLabel(n.label ?? "");
  const w = Math.max(...lines.map(units)) * LABEL_FONT + GAP_X * 2;
  const labelH = lines.length * LABEL_LINE_H;
  const h = NODE_R * 2 + labelH + GAP_Y * 2;
  // 円の中心から見た箱の中心のズレ（ラベルは円の下に出る）
  const dy = labelH / 2;
  return { w, h, dy };
}

/** id から決まる 0..1 の値。同じ曲は毎回同じ場所から始まる */
export function seed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

/**
 * まだ座標を持たないノードの初期位置（中心を囲む円環上）。
 *
 * `run` を変えると**別の初期配置**になる = 力学が落ちる谷が変わる。
 * `computeLayout` はこれで何通りも試し、線の重なりがいちばん少ない形を採る。
 * run は id と同じく入力なので、同じ run なら毎回同じ場所から始まる。
 */
export function seedNode(id: string, run: number = 0): Sim {
  const key = run === 0 ? id : `${id}#${run}`;
  const a = seed(key) * Math.PI * 2;
  const r = 160 + seed(`${key}r`) * 340;
  return { id, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 };
}

function stepOnce(active: Sim[], edges: LayoutEdge[], byId: Map<string, Sim>, alpha: number): void {
  // 反発（全ペア。数十ノードなら O(n^2) で十分）
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = seed(a.id) - 0.5; dy = seed(b.id) - 0.5; d2 = 1; }
      const f = Math.min(REPULSION / d2, 60) * alpha;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
    }
  }
  // バネ（エッジ）
  for (const e of edges) {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const f = (d - SPRING_LENGTH) * SPRING_K * alpha;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }
  // 中心への弱い引力 + 減衰
  for (const s of active) {
    if (s.pinned) { s.vx = 0; s.vy = 0; continue; } // 置き場所が決まっているものは動かさない
    s.vx = (s.vx - s.x * GRAVITY * alpha) * DAMPING;
    s.vy = (s.vy - s.y * GRAVITY * alpha) * DAMPING;
    s.x += Math.max(-24, Math.min(24, s.vx));
    s.y += Math.max(-24, Math.min(24, s.vy));
  }
}

/**
 * ラベルの箱が重なっているものを、重なりの浅い軸へ押し分ける。
 * 力学の収束後に回す。動かす量は「重なっているぶんだけ」なので、
 * せっかく作った繋がりの形をほとんど崩さずに、文字の衝突だけが消える。
 */
function separate(
  active: Sim[],
  boxes: Map<string, { w: number; h: number; dy: number }>,
  iterations: number,
): void {
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        const ba = boxes.get(a.id)!, bb = boxes.get(b.id)!;
        const dx = b.x - a.x;
        const dy = (b.y + bb.dy) - (a.y + ba.dy);
        const ox = (ba.w + bb.w) / 2 - Math.abs(dx);
        const oy = (ba.h + bb.h) / 2 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue; // 重なっていない

        moved = true;
        if (ox < oy) {
          // 横の重なりの方が浅い → 左右に開く
          const push = (ox / 2 + 0.5) * (dx < 0 ? -1 : 1);
          if (!a.pinned) a.x -= push;
          if (!b.pinned) b.x += push;
        } else {
          const push = (oy / 2 + 0.5) * (dy < 0 ? -1 : 1);
          if (!a.pinned) a.y -= push;
          if (!b.pinned) b.y += push;
        }
      }
    }
    if (!moved) break; // 全部ほどけたら終わり
  }
}

/**
 * 収束させる。`pinned` のノードは動かないので、
 * 「保存した形はそのまま、新しく増えた曲だけを馴染ませる」ができる。
 */
export function settle(
  sim: Map<string, Sim>,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  iterations: number = ITERATIONS,
): void {
  // ★ id 順に固定する。配列順が変わると浮動小数の足し算の結果が変わるため
  const active = nodes
    .map((n) => sim.get(n.id))
    .filter((s): s is Sim => !!s)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 同じ2曲の間に繋ぎが複数あることがある（並行エッジ）。
  // source/target だけで比べると同点の並びが入力順に依存し、
  // 足し算の順が変わる = 丸め誤差が変わる = 別の形に落ちる。id まで見て完全に決める。
  const key = (e: LayoutEdge) => `${e.source} ${e.target} ${e.id ?? ""}`;
  const sortedEdges = [...edges].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  let alpha = 1;
  for (let i = 0; i < iterations; i++) {
    stepOnce(active, sortedEdges, sim, alpha);
    alpha = Math.max(alpha * 0.985, 0);
  }

  // 最後にラベルの重なりを解く
  const boxes = new Map(nodes.map((n) => [n.id, boxOf(n)]));
  separate(active, boxes, 400);
}

/* ---------- 読みやすさの点数（小さいほど良い） ---------- */

/**
 * 線の交差と「線がラベルを踏んでいる数」を数える。**同じ入力なら必ず同じ数**になる
 * （座標を丸めてから数え、辺は id 順に並べてから見る）。
 *
 * 交差を完全に最小化する問題（交差数問題）は NP困難なので、**正解は出さない**。
 * ここでやるのは「何通りか試して、いちばんマシな形を選ぶ」ための物差し作りだけ。
 */
export type LayoutScore = { crossings: number; labelHits: number; score: number };

/** ラベルを踏む線1本を、交差何個ぶんとして扱うか（文字の上を通る線は交差より読みにくい） */
const LABEL_HIT_WEIGHT = 1.5;

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
};

/**
 * 2本の線分が（端点を共有せずに）交わるか。
 *
 * **数値だけを受け取る**（点や線分のオブジェクトを作らない）。仕上げの探索から
 * 何百万回と呼ばれるので、1回ごとの入れ物の生成が全体の時間を決めてしまう。
 */
function crossXY(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  // 外接の四角が重ならなければ交わらない（ほとんどの組はここで終わる）
  if (Math.min(ax, bx) > Math.max(cx, dx) || Math.max(ax, bx) < Math.min(cx, dx)) return false;
  if (Math.min(ay, by) > Math.max(cy, dy) || Math.max(ay, by) < Math.min(cy, dy)) return false;
  const d1 = orient(ax, ay, bx, by, cx, cy);
  const d2 = orient(ax, ay, bx, by, dx, dy);
  const d3 = orient(cx, cy, dx, dy, ax, ay);
  const d4 = orient(cx, cy, dx, dy, bx, by);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** 線分が長方形（ラベルの箱）を通るか。数値だけを受け取る */
function hitsRect(
  x1: number, y1: number, x2: number, y2: number,
  l: number, t: number, r: number, b: number,
): boolean {
  if (Math.min(x1, x2) > r || Math.max(x1, x2) < l) return false;
  if (Math.min(y1, y2) > b || Math.max(y1, y2) < t) return false;
  if ((x1 >= l && x1 <= r && y1 >= t && y1 <= b) || (x2 >= l && x2 <= r && y2 >= t && y2 <= b)) return true;
  return (
    crossXY(x1, y1, x2, y2, l, t, r, t) ||
    crossXY(x1, y1, x2, y2, r, t, r, b) ||
    crossXY(x1, y1, x2, y2, r, b, l, b) ||
    crossXY(x1, y1, x2, y2, l, b, l, t)
  );
}

/** 2本の線分が（端点を共有せずに）交わるか。読みやすさのための包み */
function segmentsCross(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): boolean {
  return crossXY(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2);
}

/** 線分が長方形（ラベルの箱）を通るか。箱の中で始まる/終わる線は数えない（自分の曲なので） */
function segmentHitsBox(
  s: { x1: number; y1: number; x2: number; y2: number },
  cx: number, cy: number, w: number, h: number,
): boolean {
  return hitsRect(s.x1, s.y1, s.x2, s.y2, cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
}

/**
 * 配置の読みにくさを数える。
 *
 * 見るのは2つだけ: **線同士の交差**と、**線がラベルの箱を踏んだ数**。
 * 辺の長さのばらつきや角度の均等さは足さない — 画面を見て良し悪しを確かめられないうえ、
 * 交差を減らす向きと引っ張り合うため。
 */
export function scoreLayout(nodes: LayoutNode[], edges: LayoutEdge[], pos: Layout): LayoutScore {
  // 同じ2曲の間に繋ぎが何本あっても線は同じ場所を通る。1本として数える
  const seen = new Set<string>();
  const segs: { a: string; b: string; x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const e of [...edges].sort((x, y) =>
    `${x.source} ${x.target}` < `${y.source} ${y.target}` ? -1 : 1,
  )) {
    if (e.source === e.target) continue;
    const k = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
    if (seen.has(k)) continue;
    const p = pos[e.source], q = pos[e.target];
    if (!p || !q) continue;
    seen.add(k);
    segs.push({ a: e.source, b: e.target, x1: p.x, y1: p.y, x2: q.x, y2: q.y });
  }

  let crossings = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i], t = segs[j];
      // 同じ曲から出ている線同士は、その曲の上で交わるだけなので数えない
      if (s.a === t.a || s.a === t.b || s.b === t.a || s.b === t.b) continue;
      if (segmentsCross(s, t)) crossings++;
    }
  }

  let labelHits = 0;
  for (const n of nodes) {
    const p = pos[n.id];
    if (!p) continue;
    const box = boxOf(n);
    for (const s of segs) {
      if (s.a === n.id || s.b === n.id) continue; // 自分に入る/出る線は当然当たる
      if (segmentHitsBox(s, p.x, p.y + box.dy, box.w, box.h)) labelHits++;
    }
  }

  return { crossings, labelHits, score: crossings + labelHits * LABEL_HIT_WEIGHT };
}

/* ---------- 仕上げ: 線の交差を実際に減らす ---------- */

/** 箱が重なっている組1つを、交差何個ぶんとして扱うか（文字が読めなくなるので重い） */
const OVERLAP_WEIGHT = 6;

/**
 * 線の長さの重み。**交差だけを減らすと、ほどける代わりに盤面が倍に広がる**
 * （実測: 811×1113 → 1606×1725。全体表示に収まらず、パンばかりになる）。
 * 「バネの自然長ぶん伸びたら交差 0.5 個ぶん損」として、極端に長い線を抑える
 * （実測: いちばん長い線が 1025 → 860px。交差は 35 → 42 に増えるが、盤面を横切る
 *  1本の長い線の方が目につく）。**広さ自体はこれでは縮まない** — 曲名の箱を重ねずに
 * ほどくには、素直にその面積が要るため。
 */
const LENGTH_WEIGHT = 0.5;

/** 動かし先の候補（8方向 × 3段階の距離）。ここに「隣の曲たちの真ん中」を足して使う */
const MOVE_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
const MOVE_DISTANCES = [60, 160, 320] as const;

/**
 * 力学が作った形を、**点数を見ながら直接いじって**もっと読みやすくする。
 *
 * 力学は「近いものを近くに」しか知らないので、線が交差していても平気で落ち着く
 * （実測: 力学だけだと交差 293。始める場所を 40通り変えても 264 までしか下がらない）。
 * ここでは1曲ずつ「動かしてみて、点が下がるなら採る」を繰り返し、最後に2曲の
 * 場所の入れ替えも試す。**下がるときしか動かさない**ので、必ず元より読みやすくなる。
 *
 * 点を数え直すのは**動かした曲に関わる分だけ**（全部数え直すと数十倍遅い）。
 */
function refine(
  pos: Layout,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  boxes: Map<string, { w: number; h: number; dy: number }>,
  passes: number,
): void {
  /* ---- 曲・線・箱を、添字で引ける平らな配列に移す（探索中は Map も文字列も使わない） ---- */
  const ids = nodes.map((n) => n.id).filter((id) => pos[id]).sort();
  const N = ids.length;
  if (N === 0) return;
  const index = new Map(ids.map((id, i) => [id, i]));

  const px = new Float64Array(N), py = new Float64Array(N);
  const bw = new Float64Array(N), bh = new Float64Array(N), bdy = new Float64Array(N);
  ids.forEach((id, i) => {
    px[i] = pos[id].x; py[i] = pos[id].y;
    const b = boxes.get(id) ?? { w: 0, h: 0, dy: 0 };
    bw[i] = b.w; bh[i] = b.h; bdy[i] = b.dy;
  });

  // 同じ2曲の間の繋ぎは何本あっても線は1本ぶん
  const seen = new Set<string>();
  const ea: number[] = [], eb: number[] = [];
  for (const e of [...edges].sort((x, y) =>
    `${x.source} ${x.target} ${x.id ?? ""}` < `${y.source} ${y.target} ${y.id ?? ""}` ? -1 : 1,
  )) {
    const a = index.get(e.source), b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ea.push(a); eb.push(b);
  }
  const E = ea.length;
  if (E === 0) return;

  /** その曲に付いている線の添字 */
  const incident: number[][] = Array.from({ length: N }, () => []);
  for (let i = 0; i < E; i++) { incident[ea[i]].push(i); incident[eb[i]].push(i); }

  /** 動かした曲に関わる線か（毎回作り直さず、印を付け外しする） */
  const touched = new Uint8Array(E);
  const movedFlag = new Uint8Array(N);

  /**
   * 「この曲たちに関わる分」だけの点数。動かす前後で同じ式を使うので、
   * 差が本当の変化量になる（どの項も1回だけ数える）。
   */
  const localCost = (m0: number, m1: number): number => {
    movedFlag[m0] = 1; if (m1 >= 0) movedFlag[m1] = 1;
    for (const i of incident[m0]) touched[i] = 1;
    if (m1 >= 0) for (const i of incident[m1]) touched[i] = 1;

    let cost = 0;
    for (let i = 0; i < E; i++) {
      if (!touched[i]) continue;
      const ia = ea[i], ib = eb[i];
      const ax = px[ia], ay = py[ia], bx = px[ib], by = py[ib];
      // 線が長いほど損（盤面が広がりすぎないように）
      cost += (Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) / SPRING_LENGTH) * LENGTH_WEIGHT;
      // 交差（相手も動いた線なら、i < j の側だけ数える）
      for (let j = 0; j < E; j++) {
        if (i === j || (touched[j] && j <= i)) continue;
        const ja = ea[j], jb = eb[j];
        if (ia === ja || ia === jb || ib === ja || ib === jb) continue;
        if (crossXY(ax, ay, bx, by, px[ja], py[ja], px[jb], py[jb])) cost++;
      }
      // ラベル踏み（動いた線 × 全部の箱）
      for (let k = 0; k < N; k++) {
        if (k === ia || k === ib) continue;
        const cy = py[k] + bdy[k];
        if (hitsRect(ax, ay, bx, by, px[k] - bw[k] / 2, cy - bh[k] / 2, px[k] + bw[k] / 2, cy + bh[k] / 2)) {
          cost += LABEL_HIT_WEIGHT;
        }
      }
    }
    // ラベル踏み（動いた箱 × 動いていない線）と、箱の重なり
    for (let t = 0; t < 2; t++) {
      const k = t === 0 ? m0 : m1;
      if (k < 0) continue;
      const cy = py[k] + bdy[k];
      const l = px[k] - bw[k] / 2, r = px[k] + bw[k] / 2, tp = cy - bh[k] / 2, bt = cy + bh[k] / 2;
      for (let i = 0; i < E; i++) {
        if (touched[i]) continue;
        const ia = ea[i], ib = eb[i];
        if (ia === k || ib === k) continue;
        if (hitsRect(px[ia], py[ia], px[ib], py[ib], l, tp, r, bt)) cost += LABEL_HIT_WEIGHT;
      }
      for (let o = 0; o < N; o++) {
        if (o === k || (movedFlag[o] && o <= k)) continue;
        const oy = py[o] + bdy[o];
        const ox = (bw[k] + bw[o]) / 2 - Math.abs(px[o] - px[k]);
        const ov = (bh[k] + bh[o]) / 2 - Math.abs(oy - cy);
        if (ox > 0 && ov > 0) cost += OVERLAP_WEIGHT;
      }
    }

    movedFlag[m0] = 0; if (m1 >= 0) movedFlag[m1] = 0;
    for (const i of incident[m0]) touched[i] = 0;
    if (m1 >= 0) for (const i of incident[m1]) touched[i] = 0;
    return cost;
  };

  for (let pass = 0; pass < passes; pass++) {
    let improved = false;

    // 1) 1曲ずつ動かしてみる（8方向 × 3段階 ＋ 隣の曲たちの真ん中）
    for (let k = 0; k < N; k++) {
      const x0 = px[k], y0 = py[k];
      let bestCost = localCost(k, -1);
      let bestX = x0, bestY = y0;

      const tryAt = (x: number, y: number) => {
        px[k] = x; py[k] = y;
        const cost = localCost(k, -1);
        if (cost < bestCost - 1e-9) { bestCost = cost; bestX = x; bestY = y; }
      };
      for (const d of MOVE_DISTANCES) {
        for (const [dx, dy] of MOVE_DIRS) tryAt(x0 + dx * d, y0 + dy * d);
      }
      const list = incident[k];
      if (list.length) {
        let sx = 0, sy = 0;
        for (const i of list) { const o = ea[i] === k ? eb[i] : ea[i]; sx += px[o]; sy += py[o]; }
        tryAt(Math.round(sx / list.length), Math.round(sy / list.length));
      }

      px[k] = bestX; py[k] = bestY;
      if (bestX !== x0 || bestY !== y0) improved = true;
    }

    // 2) 2曲の場所を入れ替えてみる（力学では絶対に起きない直し方）
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const before = localCost(i, j);
        const xi = px[i], yi = py[i], xj = px[j], yj = py[j];
        px[i] = xj; py[i] = yj; px[j] = xi; py[j] = yi;
        if (localCost(i, j) < before - 1e-9) improved = true;
        else { px[i] = xi; py[i] = yi; px[j] = xj; py[j] = yj; }
      }
    }

    if (!improved) break; // これ以上良くならない
  }

  ids.forEach((id, i) => { pos[id] = { x: Math.round(px[i]), y: Math.round(py[i]) }; });
}

/**
 * 計算結果の使い回し。`/graph` は開くたびにサーバで描くので、同じ曲・同じ繋ぎなら
 * 計算し直さない（RUNS 回まわす分の時間がまるまる乗るため）。
 * 鍵は**並べ替えた曲IDと繋ぎID**。数だけだと、入れ替わりが起きたときに古い形を返す。
 */
const cache = new Map<string, Layout>();
const CACHE_MAX = 4;

function signature(nodes: LayoutNode[], edges: LayoutEdge[]): string {
  const ns = nodes.map((n) => `${n.id}:${n.label ?? ""}`).sort();
  const es = edges.map((e) => `${e.id ?? ""}:${e.source}>${e.target}`).sort();
  return `${ns.join("\n")}\n--\n${es.join("\n")}`;
}

/**
 * 何通りか試して、いちばん読みやすかった形を返す。
 *
 * 力学だけだと、始めた場所しだいで良い形にも悪い形にも落ちる（実測: 自動配置の交差は
 * 246、人が手で並べた形は 72 だった）。線の交差を厳密に最小化する問題は NP困難なので、
 * **初期配置を変えて何本も回し、点数のいちばん良いものを採る**（multi-start）。
 *
 * Obsidian も同じ力学式で、交差を最小化しているわけではない。違うのは
 * 「人が毎回その場で引っ張って直せる」ことなので、こちらは**選ぶ**ことで埋める。
 *
 * 同じ入力なら同じ形でなければならないので、run は 0,1,2… と決め打ち、
 * 点が同じなら**若い run を採る**（`<` で比べる = 先に出たものが残る）。
 */
const RUNS = 12;
/** 仕上げにかける本数。仕上げは力学より重いので、見込みのある上位だけ */
const REFINE_TOP = 3;
/**
 * 仕上げの回数。4回で底を打つ（6回にしても交差は1つしか減らない）。
 * **上位1本だけを仕上げるのは博打**になる — 仕上げ前の点は仕上げ後の良し悪しを
 * 当てないので（実測: 12本から1本選ぶと 60交差、3本仕上げて選ぶと 41交差）。
 */
const REFINE_PASSES = 4;

/**
 * 全ノードの座標を決める。
 *
 * 1. **繋ぎのある曲だけ**で力学を回す（見たい構造はここにしか無い）。RUNS 回試して
 *    いちばん読みやすかった形を採る
 * 2. ラベルの箱が重ならないように押し分ける
 * 3. 繋ぎの無い曲は、その塊の下に名前順で整列させる
 *    （散らすと「未接続も表示」を押した瞬間に画面が崩壊する）
 */
export function computeLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Layout {
  const sig = signature(nodes, edges);
  const cached = cache.get(sig);
  if (cached) return cached;

  const linked = new Set<string>();
  for (const e of edges) { linked.add(e.source); linked.add(e.target); }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const connected = nodes.filter((n) => linked.has(n.id));
  const isolated = nodes
    .filter((n) => !linked.has(n.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1)); // 並びは id 順（表示名に依存させない）

  const t0 = Date.now();
  const boxes = new Map(connected.map((n) => [n.id, boxOf(n)]));

  // 1) 力学を RUNS 通り回す（速い）。ここではまだ選ばない
  const tries: { pos: Layout; sc: LayoutScore }[] = [];
  for (let run = 0; run < RUNS; run++) {
    const sim = new Map<string, Sim>();
    for (const n of connected) sim.set(n.id, seedNode(n.id, run));
    settle(sim, connected, edges);

    const pos: Layout = {};
    for (const [id, s] of sim) pos[id] = { x: Math.round(s.x), y: Math.round(s.y) };
    tries.push({ pos, sc: scoreLayout(connected, edges, pos) });
  }

  // 2) 見込みのある上位だけを仕上げる（仕上げは力学より重いので全部にはかけない）。
  //    点が同じなら run の若い方を残す = 毎回同じものが選ばれる
  tries.sort((a, b) => a.sc.score - b.sc.score);
  let out: Layout = {};
  let bestScore: LayoutScore | null = null;
  for (const t of tries.slice(0, REFINE_TOP)) {
    refine(t.pos, connected, edges, boxes, REFINE_PASSES);
    // 仕上げで箱が重なったら最後にほどく（文字が読めないのがいちばん困る）
    const sim = new Map<string, Sim>(
      connected.map((n) => [n.id, { id: n.id, x: t.pos[n.id].x, y: t.pos[n.id].y, vx: 0, vy: 0 }]),
    );
    const active = [...sim.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    separate(active, boxes, 200);
    for (const n of connected) {
      const v = sim.get(n.id)!;
      t.pos[n.id] = { x: Math.round(v.x), y: Math.round(v.y) };
    }
    const sc = scoreLayout(connected, edges, t.pos);
    if (!bestScore || sc.score < bestScore.score) { bestScore = sc; out = t.pos; }
  }
  if (process.env.LAYOUT_DEBUG) {
    console.log(`[layout] ${connected.length}曲 ${edges.length}繋ぎ / 力学だけ=${tries[tries.length - 1].sc.crossings}〜${tries[0].sc.crossings}交差 → 採用 cross=${bestScore?.crossings} label=${bestScore?.labelHits} (${Date.now() - t0}ms)`);
  }

  if (isolated.length) {
    // 繋がっている塊の下端・左端を基準にする（採用した形のもの）
    const placed = connected.map((n) => out[n.id]).filter(Boolean);
    const xs = placed.map((p) => p.x);
    const ys = placed.map((p) => p.y);
    const left = xs.length ? Math.min(...xs) : 0;
    const bottom = ys.length ? Math.max(...ys) : 0;

    const cell = isolated.map((n) => boxOf(byId.get(n.id) ?? n));
    const colW = Math.max(...cell.map((c) => c.w));
    const rowH = Math.max(...cell.map((c) => c.h));
    const cols = Math.max(1, Math.round(Math.sqrt(isolated.length * 1.6)));

    isolated.forEach((n, i) => {
      out[n.id] = {
        x: Math.round(left + (i % cols) * colW),
        y: Math.round(bottom + 160 + Math.floor(i / cols) * rowH),
      };
    });
  }

  // 古いものから捨てる（Map は入れた順に回る）
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(sig, out);
  return out;
}
