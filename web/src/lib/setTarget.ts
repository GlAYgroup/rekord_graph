import { setLength, type Hop, type Lookup, type SetLength } from "./duration";

/**
 * **何曲・何分のセットにしたいか**（/play の曲を選ぶ一覧の「長さ指定」）。
 *
 * 繋ぎが増えると「最大◯曲」は伸び続ける（実測 2026-10-04: 最大45曲・1時間9分）が、
 * 実際のセットは「30分」「10曲」と枠が決まっている。そこで枠を入れると、
 * 各曲の一番長い道筋を**その枠に収まるところで切って**出す。
 *
 * 時間は**カット後**（繋ぎで切って流した長さ = `setLength().cutSec`）で比べる。全長では比べない
 * （つないで流したら何分か、が知りたい数なので）。
 *
 * どの数も空（null）なら、その側は縛らない。
 */
export type SetTarget = {
  minSongs: number | null;
  maxSongs: number | null;
  minMinutes: number | null;
  maxMinutes: number | null;
};

export const NO_TARGET: SetTarget = { minSongs: null, maxSongs: null, minMinutes: null, maxMinutes: null };

export const hasTarget = (t: SetTarget): boolean =>
  t.minSongs != null || t.maxSongs != null || t.minMinutes != null || t.maxMinutes != null;

/** 画面に出す短い言い方（`10〜15曲・20〜30分`） */
export function targetLabel(t: SetTarget): string {
  const range = (lo: number | null, hi: number | null, unit: string) =>
    lo != null && hi != null ? (lo === hi ? `${lo}${unit}` : `${lo}〜${hi}${unit}`)
      : lo != null ? `${lo}${unit}以上`
        : hi != null ? `${hi}${unit}まで` : "";
  return [range(t.minSongs, t.maxSongs, "曲"), range(t.minMinutes, t.maxMinutes, "分")]
    .filter(Boolean).join("・");
}

const fits = (t: SetTarget, songs: number, len: SetLength): boolean => {
  const min = len.cutSec / 60;
  return (t.minSongs == null || songs >= t.minSongs) &&
    (t.maxSongs == null || songs <= t.maxSongs) &&
    (t.minMinutes == null || min >= t.minMinutes) &&
    (t.maxMinutes == null || min <= t.maxMinutes);
};

/**
 * 道筋（起点 + 繋ぎの列）を、枠に収まる**一番長いところ**で切る。収まる切り方が無ければ null。
 *
 * 道筋の頭から何本目までの繋ぎを使うかを全部試す。途中で切った道筋も道筋のまま
 * （同じ曲を2回かけない・時間の逆行が無い、は元の道筋が守っているので崩れない）。
 * 最後の曲は終わりまで流す扱い（`setLength` と同じ）。
 * 長い方を採るのは、枠いっぱいまで使える方がセットとして組みやすいため。
 */
export function fitRoute<H extends Hop & { toTrackId: string }>(
  startId: string,
  hops: readonly H[],
  lookup: Lookup,
  target: SetTarget,
): { trackIds: string[]; hops: H[]; length: SetLength } | null {
  for (let k = hops.length; k >= 0; k--) {
    const used = hops.slice(0, k);
    const trackIds = [startId, ...used.map((h) => h.toTrackId)];
    const length = setLength(trackIds, used, lookup);
    if (fits(target, trackIds.length, length)) return { trackIds, hops: used, length };
  }
  return null;
}

const num = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;

/** 端末に残した枠を読む（壊れていれば縛らない） */
export function parseTarget(raw: unknown): SetTarget {
  if (!raw || typeof raw !== "object") return NO_TARGET;
  const r = raw as Record<string, unknown>;
  return { minSongs: num(r.minSongs), maxSongs: num(r.maxSongs), minMinutes: num(r.minMinutes), maxMinutes: num(r.maxMinutes) };
}
