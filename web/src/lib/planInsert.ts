/**
 * 「セットを組む」の**差し込み**（`/play/plan` の「BPM・キーが近い所に差し込む」）。
 *
 * `planRoute` の道筋に入らなかった入れたい曲を、**記録の無い間（繋ぎ = null）**として、
 * BPM（% の差）とキー（`lib/key.ts` の `keyDistance`）がいちばん近い所へ入れる。
 *  - 道筋の**頭か尻**を好む: 隣は1曲だけで済み、記録した繋ぎを切らない
 *  - 途中に入れると、記録した繋ぎを1本切る（その前後どちらの隣とも合う必要もある）ので罰点を足す
 *  - 同じ曲（songId。リミックス違い含む）は2回入れない
 * 差し込む順は渡された順（入れたい曲を選んだ順）。1曲入れるたびに次の曲の置き場を決め直す。
 *
 * server-only を含まないので client から呼べる。
 */
import { bpmDelta } from "./format";
import { keyDistance } from "./key";

type TrackLike = { bpm: number | null; musicalKey: string; songId: string };

/** 途中に入れて、記録した繋ぎを切るときの罰点（キー1段 = 1、BPM 2% = 1 と同じ物差し） */
const BREAK_PENALTY = 3;
/** BPM が読めないときの点（6% ずれと同じくらい） */
const UNKNOWN_BPM = 3;

/** 2曲を続けてかけるときの遠さ（小さいほど近い） */
export function pairCost(a: TrackLike | undefined, b: TrackLike | undefined): number {
  const d = bpmDelta(a?.bpm ?? null, b?.bpm ?? null);
  return (d == null ? UNKNOWN_BPM : Math.abs(d) / 2) + keyDistance(a?.musicalKey, b?.musicalKey);
}

export function insertUnplaced<E extends { id: string }>(
  trackIds: readonly string[],
  edges: readonly E[],
  candidates: readonly string[],
  trackById: ReadonlyMap<string, TrackLike>,
): { trackIds: string[]; hops: (E | null)[]; inserted: string[] } {
  const ids = [...trackIds];
  const hops: (E | null)[] = [...edges];
  const songs = new Set(ids.map((id) => trackById.get(id)?.songId ?? id));
  const inserted: string[] = [];
  for (const c of candidates) {
    const track = trackById.get(c);
    const song = track?.songId ?? c;
    if (songs.has(song)) continue; // 同じ曲は2回かけない
    if (ids.length === 0) {
      ids.push(c);
    } else {
      let bestAt = 0;
      let bestCost = Infinity;
      for (let p = 0; p <= ids.length; p++) {
        const prev = p > 0 ? trackById.get(ids[p - 1]) : undefined;
        const next = p < ids.length ? trackById.get(ids[p]) : undefined;
        let cost = 0;
        if (p > 0) cost += pairCost(prev, track);
        if (p < ids.length) cost += pairCost(track, next);
        if (p > 0 && p < ids.length && hops[p - 1]) cost += BREAK_PENALTY;
        if (cost < bestCost) { bestCost = cost; bestAt = p; }
      }
      ids.splice(bestAt, 0, c);
      // 頭: 新しい曲 → 元の頭 は記録なし。尻: 元の尻 → 新しい曲 は記録なし。
      // 途中: 元の繋ぎ（p-1 → p）を、記録なしの2本に置き換える
      if (bestAt === 0 || bestAt === ids.length - 1) hops.splice(bestAt === 0 ? 0 : hops.length, 0, null);
      else hops.splice(bestAt - 1, 1, null, null);
    }
    songs.add(song);
    inserted.push(c);
  }
  return { trackIds: ids, hops, inserted };
}
