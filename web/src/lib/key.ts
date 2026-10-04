/**
 * キーの相性。**唯一の正本**（/play のカード・セットを組むの自動補完・曲ページの「まだ繋いでいない近い曲」）。
 *
 * rekordbox の Key 欄は表記が混ざっている（`Ebm` / `F#m` / `11A` …。2026-10 から Camelot 表記が増えた）ので、
 * まず Camelot（1〜12 ＋ A=マイナー / B=メジャー）に揃えてから比べる。
 *
 * 相性はよくある3段階:
 *  - `◎` … 同じキー、または相対調（同じ番号で A⇄B。Am ⇄ C）
 *  - `○` … 隣のキー（同じ文字で番号が ±1。12 と 1 は隣）
 *  - `×` … それ以外
 * どちらかの Key が読めなければ null（判定しない。未入力で「合わない」とは言わない）。
 *
 * DESIGN.md の約束で、**色は付けない**（色の意味は4つだけ）。文字で出す。
 */

export type Camelot = { num: number; letter: "A" | "B" };
export type KeyMatch = "◎" | "○" | "×";

const MAJOR: Record<string, number> = {
  B: 1, "F#": 2, Gb: 2, Db: 3, "C#": 3, Ab: 4, "G#": 4, Eb: 5, "D#": 5, Bb: 6, "A#": 6,
  F: 7, C: 8, G: 9, D: 10, A: 11, E: 12,
};
const MINOR: Record<string, number> = {
  "G#": 1, Ab: 1, "D#": 2, Eb: 2, "A#": 3, Bb: 3, F: 4, C: 5, G: 6, D: 7, A: 8, E: 9, B: 10,
  "F#": 11, Gb: 11, "C#": 12, Db: 12,
};

/** `Ebm` / `F#m` / `C` / `11A` / `8B` → Camelot。読めなければ null */
export function toCamelot(key: string | null | undefined): Camelot | null {
  const k = (key ?? "").trim().replace(/♯/g, "#").replace(/♭/g, "b");
  if (!k) return null;
  const cam = k.match(/^(\d{1,2})\s*([ABab])$/);
  if (cam) {
    const num = Number(cam[1]);
    return num >= 1 && num <= 12 ? { num, letter: cam[2].toUpperCase() as "A" | "B" } : null;
  }
  const m = k.match(/^([A-Ga-g])([#b]?)\s*(m|min|minor|maj|major)?$/);
  if (!m) return null;
  const root = m[1].toUpperCase() + m[2];
  const minor = m[3] ? /^m(in(or)?)?$/.test(m[3]) : false;
  const num = (minor ? MINOR : MAJOR)[root];
  return num ? { num, letter: minor ? "A" : "B" } : null;
}

/** 2つのキーの相性（3段階）。どちらかが読めなければ null */
export function keyMatch(a: string | null | undefined, b: string | null | undefined): KeyMatch | null {
  const x = toCamelot(a);
  const y = toCamelot(b);
  if (!x || !y) return null;
  if (x.num === y.num) return "◎"; // 同じキー or 相対調
  const d = Math.abs(x.num - y.num);
  if (x.letter === y.letter && (d === 1 || d === 11)) return "○";
  return "×";
}

/** 画面に出す短い言い方 */
export const KEY_MATCH_LABEL: Record<KeyMatch, string> = {
  "◎": "キー◎",
  "○": "キー○",
  "×": "キー×",
};
export const KEY_MATCH_TITLE: Record<KeyMatch, string> = {
  "◎": "同じキー、または相対調（そのまま重ねやすい）",
  "○": "隣のキー（Camelot で ±1。だいたい馴染む）",
  "×": "離れたキー（重ねるとぶつかりやすい）",
};

/** 近さの点（小さいほど近い）。自動補完・近い曲の並びに使う。キーが読めないときは中くらい扱い */
export const keyDistance = (a: string | null | undefined, b: string | null | undefined): number => {
  const m = keyMatch(a, b);
  return m === "◎" ? 0 : m === "○" ? 1 : m === "×" ? 3 : 2;
};
