import "server-only";
import { DB, hasDb, request, text, type NotionPage } from "./notion";
import type { Playlist } from "./playlist";

/**
 * イベントごとのプレイリストの保存と読み出し。置き場所は Notion の 🎶Playlists DB
 * （スマホで組んで、当日は別の端末で開けるように、端末には置かない）。
 *
 * 作りは `lib/patterns.ts`（🗺️Layouts）と同じ:
 *  - 曲は rekordbox の ContentID で持つ（Notion を作り直しても残る）
 *  - rich_text は1要素 2000 文字までなので刻む
 *  - ID で書く前に、その ID が 🎶Playlists の行かを必ず確かめる（`isPlaylistPage`）
 *  - 消すのはアーカイブ（Notion から戻せる）
 * DB は任意（`hasDb("playlists")`）。無ければ一覧は空で、書き込みは null を返す。
 */

const CHUNK = 1900;
/** 記録に無い間（繋ぎなし）の印 */
const NO_HOP = "-";

const chunks = (s: string) => {
  const out: { type: "text"; text: { content: string } }[] = [];
  for (let i = 0; i < s.length; i += CHUNK) out.push({ type: "text", text: { content: s.slice(i, i + CHUNK) } });
  return out;
};

const words = (s: string) => s.split(/\s+/).filter(Boolean);

function toPlaylist(page: NotionPage): Playlist {
  const p = page.properties;
  const trackRbIds = words(text(p["曲"]));
  const raw = words(text(p["繋ぎ"])).map((h) => (h === NO_HOP ? null : h));
  // 繋ぎの数は必ず 曲数 − 1 に揃える（手で Notion を直して崩れても、ずれて読まない）
  const hops = Array.from({ length: Math.max(0, trackRbIds.length - 1) }, (_, i) => raw[i] ?? null);
  return {
    id: page.id,
    name: text(p["名前"]) || "無題",
    date: p["日付"]?.date?.start?.slice(0, 10) ?? null,
    memo: text(p["メモ"]),
    trackRbIds,
    hops,
    editedTime: page.last_edited_time ?? "",
  };
}

/** 日付が新しい順（日付なしは後ろ）→ 最後に直した順 */
export async function listPlaylists(): Promise<Playlist[]> {
  if (!hasDb("playlists")) return [];
  const res = await request<{ results: NotionPage[] }>(`/databases/${DB.playlists}/query`, {
    method: "POST",
    body: { page_size: 100, sorts: [{ timestamp: "last_edited_time", direction: "descending" }] },
    fresh: true,
  });
  return res.results
    .map(toPlaylist)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.editedTime.localeCompare(a.editedTime));
}

const normId = (id: string) => id.replace(/-/g, "").toLowerCase();

/** `id` が 🎶Playlists の（捨てていない）行か。読めない ID も「違う」に倒す */
async function isPlaylistPage(id: string): Promise<boolean> {
  if (!hasDb("playlists")) return false;
  const page = await request<{ parent?: { database_id?: string }; archived?: boolean }>(
    `/pages/${encodeURIComponent(id)}`, { fresh: true },
  ).catch(() => null);
  return !!page && !page.archived && normId(page.parent?.database_id ?? "") === normId(DB.playlists);
}

export async function getPlaylist(id: string): Promise<Playlist | null> {
  if (!(await isPlaylistPage(id))) return null;
  return toPlaylist(await request<NotionPage>(`/pages/${encodeURIComponent(id)}`, { fresh: true }));
}

export type PlaylistInput = Omit<Playlist, "id" | "editedTime">;

function properties(pl: PlaylistInput) {
  const hops = Array.from({ length: Math.max(0, pl.trackRbIds.length - 1) }, (_, i) => pl.hops[i] ?? NO_HOP);
  return {
    名前: { title: [{ type: "text", text: { content: pl.name.slice(0, 100) } }] },
    日付: { date: pl.date ? { start: pl.date } : null },
    曲: { rich_text: chunks(pl.trackRbIds.join(" ")) },
    繋ぎ: { rich_text: chunks(hops.join(" ")) },
    曲数: { number: pl.trackRbIds.length },
    メモ: { rich_text: chunks(pl.memo) },
  };
}

/** `id` を渡せば上書き、渡さなければ新規作成。DB が無い・`id` が 🎶Playlists の行でなければ何も書かず null */
export async function savePlaylist(pl: PlaylistInput, id?: string): Promise<Playlist | null> {
  if (!hasDb("playlists")) return null;
  if (id && !(await isPlaylistPage(id))) return null;
  const body = { properties: properties(pl) };
  const page = id
    ? await request<NotionPage>(`/pages/${encodeURIComponent(id)}`, { method: "PATCH", body, fresh: true })
    : await request<NotionPage>("/pages", {
        method: "POST",
        body: { parent: { database_id: DB.playlists }, ...body },
        fresh: true,
      });
  return toPlaylist(page);
}

/** アーカイブする（Notion から戻せる）。`id` が 🎶Playlists の行でなければ何もせず false */
export async function deletePlaylist(id: string): Promise<boolean> {
  if (!(await isPlaylistPage(id))) return false;
  await request(`/pages/${encodeURIComponent(id)}`, { method: "PATCH", body: { archived: true }, fresh: true });
  return true;
}
