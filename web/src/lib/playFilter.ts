/**
 * `/play` の除外条件の**判定**。唯一の正本。
 * プレイ画面（繋ぎを外す・曲を選ぶ一覧の並び）と入力画面（登録済み一覧の絞り込み）が
 * 同じ答えを出すように、判定はここ1箇所に置く。server-only を含まないので client から呼べる。
 *
 * 条件そのもの（`PlayFilter`）の保存は `lib/playlog.ts`。
 * 難易度・星・ジャンル・タグは **未入力なら外さない**（後から付けていくもののため）。
 */
import { difficultyRank } from "./difficulty";
import { genreKey } from "./format";
import type { PlayFilter } from "./playlog";
import { starCount } from "./ratings";

/** 判定に要る曲の情報。`Track` でも、入力画面の軽い形でも通る */
export type FilterTrack = { genre: string; myTags: string[] };
/** 判定に要る繋ぎの情報 */
export type FilterHop = { difficulty: string | null; rating: string | null; practice: boolean };

export const isFiltering = (f: PlayFilter): boolean =>
  f.maxDifficulty !== null || f.minStars > 0 || f.skipPractice ||
  f.skipGenres.length > 0 || f.skipTags.length > 0;

/** 除外条件を短く言う（ボタンに出す）。`Middleまで・★★★以上` */
export function filterSummary(f: PlayFilter): string {
  const parts: string[] = [];
  if (f.maxDifficulty) parts.push(`${f.maxDifficulty}まで`);
  if (f.minStars > 0) parts.push(`${"★".repeat(f.minStars)}以上`);
  if (f.skipPractice) parts.push("要練習なし");
  if (f.skipGenres.length > 0) parts.push(`ジャンル${f.skipGenres.length}つ`);
  if (f.skipTags.length > 0) parts.push(`タグ${f.skipTags.length}つ`);
  return parts.join("・");
}

/** ジャンル・My Tag の条件で外す曲か。**未入力は外さない** */
export function skipsTrack(f: PlayFilter, to: FilterTrack | undefined): boolean {
  return trackReasons(f, to).length > 0;
}

function trackReasons(f: PlayFilter, to: FilterTrack | undefined): string[] {
  if (!to) return [];
  const out: string[] = [];
  const g = genreKey(to.genre);
  if (g && f.skipGenres.includes(g)) out.push(to.genre);
  for (const tag of to.myTags) if (f.skipTags.includes(tag)) out.push(tag.slice(tag.indexOf("/") + 1));
  return out;
}

/**
 * 繋ぎがどの条件で外れるか（外れなければ空）。入力画面は理由をそのまま札にする。
 * 判定の順は要練習 → 行き先の曲 → 難易度 → 星
 */
export function filterReasons(f: PlayFilter, t: FilterHop, to: FilterTrack | undefined): string[] {
  const out: string[] = [];
  if (f.skipPractice && t.practice) out.push("要練習");
  out.push(...trackReasons(f, to));
  const maxRank = difficultyRank(f.maxDifficulty);
  if (maxRank > 0 && difficultyRank(t.difficulty) > maxRank) out.push(t.difficulty ?? "");
  const stars = starCount(t.rating);
  if (f.minStars > 0 && stars > 0 && stars < f.minStars) out.push(t.rating ?? "");
  return out;
}

export const passesFilter = (f: PlayFilter, t: FilterHop, to: FilterTrack | undefined): boolean =>
  filterReasons(f, t, to).length === 0;

export type SkipChoice = { key: string; label: string; count: number };
export type TagGroup = { category: string; tags: SkipChoice[] };

/**
 * 条件の画面に並べるジャンルと My Tag = **繋ぎの行き先になっている曲**に付いているものだけ
 * （外して意味があるもの）。`dests` は行き先の曲を1曲1回ずつ。
 * ジャンルの表記ゆれは `genreKey` で束ね、見出しは一番多い書き方。どちらも曲の多い順。
 * 外したまま曲が消えた（ジャンルを直した）ものも、外し直せるように 0 で残す
 */
export function filterChoices(
  dests: readonly FilterTrack[],
  f: PlayFilter,
): { genres: SkipChoice[]; tagGroups: TagGroup[] } {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
  const tagCount = new Map<string, number>();
  for (const to of dests) {
    const key = genreKey(to.genre);
    if (key) {
      const e = byKey.get(key) ?? { count: 0, spellings: new Map() };
      e.count += 1;
      e.spellings.set(to.genre, (e.spellings.get(to.genre) ?? 0) + 1);
      byKey.set(key, e);
    }
    for (const tag of to.myTags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  }
  for (const key of f.skipGenres) {
    if (!byKey.has(key)) byKey.set(key, { count: 0, spellings: new Map([[key, 1]]) });
  }
  for (const tag of f.skipTags) if (!tagCount.has(tag)) tagCount.set(tag, 0);

  const genres = [...byKey]
    .map(([key, e]) => ({
      key,
      count: e.count,
      label: [...e.spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ja"));

  const groups = new Map<string, SkipChoice[]>();
  for (const [tag, n] of tagCount) {
    const cut = tag.indexOf("/");
    const cat = tag.slice(0, cut);
    (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push({ key: tag, label: tag.slice(cut + 1), count: n });
  }
  const tagGroups = [...groups]
    .map(([category, tags]) => ({
      category,
      tags: tags.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ja")),
    }))
    .sort((a, b) => a.category.localeCompare(b.category, "ja"));

  return { genres, tagGroups };
}
