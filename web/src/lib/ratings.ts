/**
 * 評価（🔀Transitions の「評価」= 星）の選択肢。**唯一の正本。**
 *
 * ここを一次情報にしておかないと、Notion の select に
 * `★★★ ` のような揺れた選択肢が生えて二度と消せなくなる。
 * 入力画面・グラフ・曲ページ・API のどこもこの配列だけを見ること。
 * server-only を含まないので client からも import できる。
 */
export const RATINGS = ["★", "★★", "★★★", "★★★★", "★★★★★"] as const;

export type Rating = (typeof RATINGS)[number];

/** 保存されている文字列を星の数にする。知らない値は 0（未評価）として扱う。 */
export const starCount = (value: string | null | undefined): number =>
  value ? RATINGS.indexOf(value as Rating) + 1 : 0;

/** 星の数を保存する文字列にする。0 は「評価なし」= null。 */
export const ratingOf = (stars: number): string | null =>
  stars >= 1 && stars <= RATINGS.length ? RATINGS[stars - 1] : null;
