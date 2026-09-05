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

/** まだ座標を持たないノードの初期位置（中心を囲む円環上） */
export function seedNode(id: string): Sim {
  const a = seed(id) * Math.PI * 2;
  const r = 160 + seed(`${id}r`) * 340;
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
  const key = (e: LayoutEdge) => `${e.source} ${e.target} ${e.id ?? ""}`;
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

/**
 * 全ノードの座標を決める。
 *
 * 1. **繋ぎのある曲だけ**で力学を回す（見たい構造はここにしか無い）
 * 2. ラベルの箱が重ならないように押し分ける
 * 3. 繋ぎの無い曲は、その塊の下に名前順で整列させる
 *    （散らすと「未接続も表示」を押した瞬間に画面が崩壊する）
 */
export function computeLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Layout {
  const linked = new Set<string>();
  for (const e of edges) { linked.add(e.source); linked.add(e.target); }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const connected = nodes.filter((n) => linked.has(n.id));
  const isolated = nodes
    .filter((n) => !linked.has(n.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1)); // 並びは id 順（表示名に依存させない）

  const sim = new Map<string, Sim>();
  for (const n of connected) sim.set(n.id, seedNode(n.id));
  settle(sim, connected, edges);

  const out: Layout = {};
  for (const [id, s] of sim) out[id] = { x: Math.round(s.x), y: Math.round(s.y) };

  if (isolated.length) {
    // 繋がっている塊の下端・左端を基準にする
    const xs = [...sim.values()].map((s) => s.x);
    const ys = [...sim.values()].map((s) => s.y);
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

  return out;
}
