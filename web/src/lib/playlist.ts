/**
 * イベントごとのプレイリスト（🎶Playlists）の形と、並びの**確かめ**。唯一の正本。
 * server-only を含まないので client（編集画面）からも呼べる。読み書きは `lib/playlists.ts`（server）。
 *
 * 1本 = 曲の並び（rekordbox の ContentID）＋ 曲と曲の間の繋ぎ（🔀Transitions のページID。記録に無い間は null）。
 * 曲を ContentID で持つのは 🗺️Layouts と同じ理由（Notion を作り直しても残る。`tools/rb_playlist.py` もそのまま使える）。
 *
 * 手で並べると /play の約束（同じ曲は2回かけない・時間が逆行する繋ぎは辿らない）を破れるので、
 * **止めずに警告として出す**（`checkPlaylist`）。止めると「まだ繋ぎが無い曲も入れておく」ができなくなる。
 */
import { canFollow, type Timing } from "./duration";
import { starCount } from "./ratings";
import type { Transition } from "./types";

export type Playlist = {
  id: string;
  name: string;
  /** イベントの日付（YYYY-MM-DD）。未入力は null */
  date: string | null;
  memo: string;
  /** 曲の並び。rekordbox の ContentID */
  trackRbIds: string[];
  /** `hops[i]` が `trackRbIds[i]` → `trackRbIds[i+1]` の繋ぎ（ページID）。記録に無い間は null。長さは曲数 − 1 */
  hops: (string | null)[];
  editedTime: string;
};

/**
 * 2曲の間の繋ぎを1本選ぶ（同じ2曲の間に複数あるときがある）。**星が多い → 古い → ID の順**で決め打ち
 * （毎回同じものを選ぶ。どれを選んだかは画面に出す）。無ければ null
 */
export function pickTransition(
  fromId: string,
  toId: string,
  transitions: readonly Transition[],
): Transition | null {
  const list = transitions.filter((t) => t.fromTrackId === fromId && t.toTrackId === toId);
  list.sort(
    (a, b) =>
      starCount(b.rating) - starCount(a.rating) ||
      a.createdTime.localeCompare(b.createdTime) ||
      a.id.localeCompare(b.id),
  );
  return list[0] ?? null;
}

/**
 * 曲の並び（曲ID）に合わせて、間の繋ぎを揃え直す。今まで選んでいた繋ぎ（`chosen`。位置は問わない）の中に
 * その2曲を結ぶものがあれば残し（並べ替えても人が選んだ繋ぎを失わない）、無ければその2曲の間から選び直す。
 * 記録に無ければ null
 */
export function alignHops(
  trackIds: readonly string[],
  chosen: readonly (string | null)[],
  transitions: readonly Transition[],
): (string | null)[] {
  const byId = new Map(transitions.map((t) => [t.id, t]));
  const kept = chosen.map((id) => (id ? byId.get(id) : undefined)).filter((t): t is Transition => !!t);
  const out: (string | null)[] = [];
  for (let i = 0; i + 1 < trackIds.length; i++) {
    const mine = kept.find((t) => t.fromTrackId === trackIds[i] && t.toTrackId === trackIds[i + 1]);
    out.push(mine?.id ?? pickTransition(trackIds[i], trackIds[i + 1], transitions)?.id ?? null);
  }
  return out;
}

export type PlaylistIssue =
  /** `index` と次の曲の間に繋ぎが記録されていない */
  | { kind: "noHop"; index: number }
  /** `index` の曲に入った位置より前から、次の曲へ抜ける（時間が逆行する。`canFollow`） */
  | { kind: "reversed"; index: number }
  /** `index` の曲は、それより前に同じ曲（リミックス違い含む）がある */
  | { kind: "sameSong"; index: number; firstIndex: number };

/** 並びの確かめ。止めはしない（画面が警告として出す） */
export function checkPlaylist(
  trackIds: readonly string[],
  hops: readonly (string | null)[],
  songOf: (trackId: string) => string,
  transitionById: ReadonlyMap<string, Transition>,
  timing: (t: Transition) => Timing,
): PlaylistIssue[] {
  const issues: PlaylistIssue[] = [];
  const seen = new Map<string, number>();
  trackIds.forEach((id, i) => {
    const song = songOf(id);
    const first = seen.get(song);
    if (first != null) issues.push({ kind: "sameSong", index: i, firstIndex: first });
    else seen.set(song, i);
  });
  for (let i = 0; i + 1 < trackIds.length; i++) {
    const out = hops[i] ? transitionById.get(hops[i]!) : undefined;
    if (!out) { issues.push({ kind: "noHop", index: i }); continue; }
    const into = i > 0 && hops[i - 1] ? transitionById.get(hops[i - 1]!) : undefined;
    if (into && !canFollow(timing(into), timing(out))) issues.push({ kind: "reversed", index: i });
  }
  return issues;
}
