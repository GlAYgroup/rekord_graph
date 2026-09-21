/**
 * 難易度（🔀Transitions の「難易度」）の選択肢。**唯一の正本。**
 *
 * `ratings.ts` と同じ理由でここを一次情報にする: 選択肢が揺れると Notion の select に
 * 消せない選択肢が生える。入力画面・API・プレイ画面のどこもこの配列だけを見ること。
 * 並びは易しい順で、`/play` の「◯まで」はこの順位で決める。
 * server-only を含まないので client からも import できる。
 */
export const DIFFICULTIES = ["Easy", "Middle", "Hard"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

/** 画面に出す読み。保存する値（英語）は変えずに、日本語を添える */
export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  Easy: "Easy 易しい",
  Middle: "Middle 中",
  Hard: "Hard 難しい",
};

/** 知っている値だけを通す。API はこれで弾く（打ち間違いで select の選択肢を増やさない） */
export const asDifficulty = (value: unknown): Difficulty | null =>
  DIFFICULTIES.includes(value as Difficulty) ? (value as Difficulty) : null;

/** 易しい順の順位（1..3）。未入力・知らない値は 0 */
export const difficultyRank = (value: string | null | undefined): number =>
  value ? DIFFICULTIES.indexOf(value as Difficulty) + 1 : 0;
