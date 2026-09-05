/**
 * 表示用の小さな変換。**server-only を含まない**ので client からも読める。
 * （`lib/graph.ts` は Notion アクセスを抱えていて server 専用なので、
 *   クライアント側のコンポーネントからは絶対に import しないこと）
 */

/** ミリ秒 -> `2:36.133`。DJ が読む桁は 1/1000 秒まで */
export function formatPosition(ms: number | null): string {
  if (ms == null) return "";
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

/** BPM 差を % で返す。テンポが合うかを一目で見るため。 */
export function bpmDelta(from: number | null, to: number | null): number | null {
  if (!from || !to) return null;
  return ((to - from) / from) * 100;
}

/**
 * キュー1つの短い表し方 = `F「1サビ終」`。**文字列で出す所は全部これを通す。**
 * （曲ページ・グラフのパネル・ツリー・入力画面の一覧が、同じ形で読めること）
 */
export type CueLike = { letter: string | null; name: string; loop?: boolean };

/** キュー名が既に「ループ」と言っているか。実データに `1サビ終ループ` が普通にある */
const LOOP_IN_NAME = /ループ|loop/i;

/**
 * 「ループ」と添えるべきキューか。
 *
 * rekordbox でループになっている（終わりの位置が入っている）ことが判断の元。
 * ただし**キュー名が既に「ループ」と言っているなら添えない** — キュー名が正で、
 * `D「1サビ終ループ」ループ` は同じことを2回言っているだけになる。
 */
export const showsLoop = (cue: CueLike | undefined): boolean =>
  !!cue?.loop && !LOOP_IN_NAME.test(cue.name);

export function cueLabel(cue: CueLike | undefined): string {
  if (!cue) return "?";
  return `${cue.letter ?? "?"}「${cue.name || "無名"}」${showsLoop(cue) ? " ループ" : ""}`;
}

/**
 * 小節数の短い表し方 = `次の曲 C「歌入り」の16小節前`。**文字列で出す所は全部これを通す。**
 *
 * 小節数の意味は「**次の曲（To）のキューの何小節前**から繋ぎ始めるか」。
 * From 側で使う長さではないので、「16小節」とだけ出すと逆向きに読める。
 * `toCueLabel` には `cueLabel` で組み立てた文字列を渡す。
 */
export function barsLabel(bars: number | null | undefined, toCueLabel: string): string | null {
  if (bars == null) return null;
  return `次の曲 ${toCueLabel}の${bars}小節前`;
}

/** ループの長さ（ms）。始まりと終わりの差。ループでなければ null */
export function loopLengthMs(cue: { positionMs: number | null; loopEndMs?: number | null }): number | null {
  if (cue.loopEndMs == null || cue.positionMs == null) return null;
  const len = cue.loopEndMs - cue.positionMs;
  return len > 0 ? len : null;
}
