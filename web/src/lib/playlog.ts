/**
 * プレイ画面（`/play`）が端末に残すもの = **今のセットの途中**と、**終わったセットの履歴**。
 *
 * かけてきた順はその場その場の話なので Notion には書かない（CLAUDE.md の約束）。
 * 履歴も同じ性質のものなので、**localStorage だけ**が持つ。
 *
 * 1手 = `{ かけた曲, その曲へ入るのに使った繋ぎ }`。
 * 繋ぎが `null` なのは「曲を変える」で記録に無い曲へ移ったとき。
 * 後から曲の組でひき直すことはできない（同じ2曲の間に繋ぎが複数あるため）ので、
 * **押した繋ぎの ID をその場で残す**。
 */

export type PlayStep = {
  trackId: string;
  /** この曲へ入るのに使った 🔀Transitions の ID。「曲を変える」で移ったときは null */
  viaTransitionId: string | null;
};

export type PlaySet = {
  id: string;
  /** 終わった（＝リセット / 別のセットに置き換わった）時刻 */
  endedAt: number;
  steps: PlayStep[];
};

/** 今のセットの途中。v1 は曲IDの配列だけだったので、読むときに 1度だけ拾い直す */
const CURRENT = "rg.play.v2";
const CURRENT_V1 = "rg.play.v1";
const HISTORY = "rg.play.history.v1";

/** 履歴の上限。端末に無限に貯めない（古いものから捨てる） */
const MAX_SETS = 50;

const isStep = (x: unknown): x is PlayStep =>
  !!x && typeof x === "object" &&
  typeof (x as PlayStep).trackId === "string" &&
  ((x as PlayStep).viaTransitionId === null || typeof (x as PlayStep).viaTransitionId === "string");

const parse = (key: string): unknown => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; } // 使えない端末（プライベートモード等）では何も残さない
};

const write = (key: string, value: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 残せなければ諦める */ }
};

/** 今のセットの途中を読む。v1（曲IDだけ）で残っていた分は繋ぎ不明として拾う */
export function readCurrent(): PlayStep[] {
  const v2 = parse(CURRENT);
  if (Array.isArray(v2)) return v2.filter(isStep);
  const v1 = parse(CURRENT_V1);
  if (Array.isArray(v1)) {
    return v1
      .filter((x): x is string => typeof x === "string")
      .map((trackId) => ({ trackId, viaTransitionId: null }));
  }
  return [];
}

export function writeCurrent(steps: PlayStep[]) {
  write(CURRENT, steps);
}

export function readHistory(): PlaySet[] {
  const raw = parse(HISTORY);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s): s is PlaySet =>
        !!s && typeof s === "object" &&
        typeof (s as PlaySet).id === "string" &&
        typeof (s as PlaySet).endedAt === "number" &&
        Array.isArray((s as PlaySet).steps),
    )
    .map((s) => ({ ...s, steps: s.steps.filter(isStep) }));
}

/**
 * 終わったセットを履歴の先頭に積む。
 *
 * **1曲だけのセットは残さない** — 繋いだ記録が1本も無く、履歴として読むものが無いため。
 * 曲が rekordbox から消えていても ID はそのまま残す（読むときに「不明な曲」として出す。
 * 落として詰めると、セットの中の1手が黙って消える方が困る）。
 */
export function archive(steps: PlayStep[]): PlaySet | null {
  if (steps.length < 2) return null;
  const set: PlaySet = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    endedAt: Date.now(),
    steps,
  };
  write(HISTORY, [set, ...readHistory()].slice(0, MAX_SETS));
  return set;
}

export function deleteSet(id: string): PlaySet[] {
  const rest = readHistory().filter((s) => s.id !== id);
  write(HISTORY, rest);
  return rest;
}

/**
 * `/play` の除外条件。**端末の設定**なので、かけてきた順と同じく localStorage だけが持つ
 * （セットをリセットしても残す = 「今夜は Hard を使わない」は1セットより長く効く）。
 *
 * 難易度・星・ジャンルは **未入力なら外さない**。難易度・評価は後から付けていくものなので、
 * 未入力を外すと条件を入れた瞬間にほとんどの繋ぎが消える（壊れたように見える）。
 */
export type PlayFilter = {
  /** 難易度がこれを超える繋ぎを外す（`lib/difficulty.ts` の値）。null = 外さない */
  maxDifficulty: string | null;
  /** 星がこれ未満の繋ぎを外す。0 = 外さない */
  minStars: number;
  /** 要練習マークの付いた繋ぎを外す（「まだ本番で使えない」印なので） */
  skipPractice: boolean;
  /** 行き先の曲のジャンルがこれに入る繋ぎを外す（`genreKey` の値）。ジャンル未入力の曲は外さない */
  skipGenres: string[];
  /** 行き先の曲にこの My Tag（`原曲/アニメ`）が1つでも付いていれば外す */
  skipTags: string[];
};

export const NO_FILTER: PlayFilter = { maxDifficulty: null, minStars: 0, skipPractice: false, skipGenres: [], skipTags: [] };

/** 除外条件の保存先。`lib/useStoredFilter.ts`（グラフ）も同じ鍵を見る */
export const FILTER = "rg.play.filter.v1";

export function readFilter(): PlayFilter {
  const raw = parse(FILTER) as Partial<PlayFilter> | null;
  if (!raw || typeof raw !== "object") return NO_FILTER;
  return {
    maxDifficulty: typeof raw.maxDifficulty === "string" ? raw.maxDifficulty : null,
    minStars: typeof raw.minStars === "number" ? raw.minStars : 0,
    skipPractice: raw.skipPractice === true,
    skipGenres: Array.isArray(raw.skipGenres)
      ? raw.skipGenres.filter((g): g is string => typeof g === "string" && g !== "")
      : [],
    skipTags: Array.isArray(raw.skipTags)
      ? raw.skipTags.filter((g): g is string => typeof g === "string" && g !== "")
      : [],
  };
}

export function writeFilter(f: PlayFilter) {
  write(FILTER, f);
}

/**
 * `/play/plan`（セットを組む）の中身。**入れたい曲の選択**と、「この順で始める」で渡した**道筋**。
 * 道筋は繋ぎ ID で持つ（同じ2曲の間に繋ぎが複数あるので、曲の組では引き直せない）。
 * `/play` はこれを見て、予定の繋ぎのカードに「予定」の印を付ける（並びは変えない）。
 */
export type PlayPlan = {
  /** 入れたい曲（曲ID） */
  wanted: string[];
  /** 「この順で始める」を押したときの道筋（繋ぎ ID）。まだ始めていなければ空 */
  route: string[];
};

/** 保存先。`lib/useStoredPlan.ts` も同じ鍵を見る */
export const PLAN = "rg.play.plan.v1";

const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];

export function readPlan(): PlayPlan {
  const raw = parse(PLAN) as Partial<PlayPlan> | null;
  if (!raw || typeof raw !== "object") return { wanted: [], route: [] };
  return { wanted: strings(raw.wanted), route: strings(raw.route) };
}

export function writePlan(plan: PlayPlan) {
  write(PLAN, plan);
}
