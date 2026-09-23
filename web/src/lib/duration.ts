/**
 * つなげたときに**何分のセットになるか**を出す。**唯一の正本。**
 * server-only を含まないので client（/play）からも呼べる。
 *
 * 2つの数を出す:
 *  - 全長: 通る曲の長さをそのまま足したもの（曲を頭から最後まで流した場合）
 *  - カット後: 繋ぎで切った分を引いたもの。1曲ごとに「入った位置 → 抜ける位置」だけを数える
 *
 * 1曲の中の区間:
 *  - 入る位置 = その曲へ入った繋ぎの To キュー。`小節数` なら その小節数ぶん**前**、
 *    `小節数（後）` なら**後**（小節 → 時間は To 曲の BPM で 4拍 × 60 / BPM）。
 *    曲の頭より前になるときは 0（頭から流す）。実測で133本中11本がそうなる
 *  - 抜ける位置 = 次の繋ぎの From キュー（その位置で次の曲を入れ始める）
 *  - 最初の曲は頭から（入った繋ぎが無い）、最後の曲は終わりまで流す
 *
 * 区間が負になる（入った位置より前で抜ける）ことは実データでは起きない（2026-09-22 実測:
 * 285通り中0件）が、起きたら 0 として数える。位置・長さ・BPM が欠けた曲は全長で数え、
 * `approx` を立てる（出す数は目安になる）。
 */

export type Hop = {
  toCueId: string;
  fromCueId: string;
  bars: number | null;
  barsAfter: number | null;
};

type Lookup = {
  durationSec: (trackId: string) => number | null;
  bpm: (trackId: string) => number | null;
  cueMs: (cueId: string) => number | null;
};

export type SetLength = { fullSec: number; cutSec: number; approx: boolean };

/** 繋ぎ `t` で To 曲へ入ったとき、To 曲のどこから流し始めるか（ms）。分からなければ null */
export function entryMs(t: Hop, toBpm: number | null, lookup: Pick<Lookup, "cueMs">): number | null {
  const at = lookup.cueMs(t.toCueId);
  if (at == null) return null;
  const bar = toBpm ? (4 * 60_000) / toBpm : null;
  // 「後」を先に見る（`barsLabel` と同じ順。両方入っていても答えを2つ出さない）
  if (t.barsAfter != null) return bar == null ? null : at + t.barsAfter * bar;
  if (t.bars != null) return bar == null ? null : Math.max(0, at - t.bars * bar);
  return at;
}

/** 1本の繋ぎの時刻。入る = To 曲のどこから流すか（`entryMs`）、抜ける = From キューの位置 */
export type Timing = { entryMs: number | null; exitMs: number | null };

export function timingOf(t: Hop & { toTrackId: string }, lookup: Omit<Lookup, "durationSec">): Timing {
  return { entryMs: entryMs(t, lookup.bpm(t.toTrackId), lookup), exitMs: lookup.cueMs(t.fromCueId) };
}

/**
 * 繋ぎ `prev` で入った曲から、繋ぎ `next` で抜けられるか。**抜ける位置が入った位置より後のときだけ**
 * （同じ位置も不可 = その曲を1秒も流さない）。位置が分からなければ通す（未入力で外さない）。
 * 実データでは起きていない（2026-09-24 実測: 315通り中0件）が、起きたら**繋がりとして数えない** —
 * /play の一覧・「この先◯曲」・最長ルートは `lib/route.ts` がこの判定で辿る
 */
export function canFollow(prev: Timing | null, next: Timing): boolean {
  if (prev?.entryMs == null || next.exitMs == null) return true;
  return next.exitMs > prev.entryMs;
}

/**
 * 曲の並び `trackIds` と、その間の繋ぎ `hops`（`hops[i]` が `trackIds[i]` → `trackIds[i+1]`）から
 * セットの長さを出す。`enteredBy` は最初の曲へ入ってきた繋ぎ（/play の「今の曲」から数えるとき）。
 * 無ければ最初の曲は頭から流す。
 */
export function setLength(
  trackIds: readonly string[],
  hops: readonly Hop[],
  lookup: Lookup,
  enteredBy: Hop | null = null,
): SetLength {
  let fullSec = 0;
  let cutMs = 0;
  let approx = false;
  trackIds.forEach((id, i) => {
    const dur = lookup.durationSec(id);
    if (dur == null) { approx = true; return; }
    fullSec += dur;
    const into = i === 0 ? enteredBy : hops[i - 1];
    const start = into ? entryMs(into, lookup.bpm(id), lookup) : 0;
    const out = hops[i];
    const end = out ? lookup.cueMs(out.fromCueId) : dur * 1000;
    if (start == null || end == null) { approx = true; cutMs += dur * 1000; return; }
    cutMs += Math.max(0, Math.min(end, dur * 1000) - start);
  });
  return { fullSec, cutSec: cutMs / 1000, approx };
}

/** 秒 → `約48分` / `約1時間12分`。セットの長さは分の単位で足りる */
export function minutesLabel(sec: number): string {
  const min = Math.round(sec / 60);
  if (min < 60) return `約${min}分`;
  return `約${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ""}`;
}
