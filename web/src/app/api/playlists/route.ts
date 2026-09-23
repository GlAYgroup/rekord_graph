import { hasDb } from "@/lib/notion";
import { deletePlaylist, listPlaylists, savePlaylist, type PlaylistInput } from "@/lib/playlists";

/**
 * イベントごとのプレイリスト（🎶Playlists）。/playlists の画面と「プレイリストとして保存」だけが叩く。
 * 書くのは 🎶Playlists だけで、rekordbox の鏡（🎵Tracks / 📍Cues）には触らない。
 * rekordbox へは `tools/rb_playlist.py` がローカルで書き出す（Vercel からは master.db に触れない）。
 */
export const dynamic = "force-dynamic";

const notSetUp = () =>
  Response.json({ error: "🎶Playlists の DB が設定されていません（NOTION_DB_PLAYLISTS）" }, { status: 503 });
const notFound = () => Response.json({ error: "そのプレイリストは見つかりません" }, { status: 404 });

/** rekordbox の ContentID は数字。Notion のページID は 32桁の16進（ハイフンあり・なし） */
const RB_ID = /^\d{1,20}$/;
const PAGE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function parse(body: Record<string, unknown> | null): PlaylistInput | string {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return "名前が要ります";
  const date = body?.date == null || body.date === "" ? null : body.date;
  if (date !== null && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))) return "日付は YYYY-MM-DD で送ってください";
  const memo = typeof body?.memo === "string" ? body.memo : "";
  const tracks = body?.trackRbIds;
  if (!Array.isArray(tracks) || !tracks.every((t) => typeof t === "string" && RB_ID.test(t))) {
    return "trackRbIds は rekordbox の ContentID（数字）の配列で送ってください";
  }
  const hops = body?.hops;
  if (
    !Array.isArray(hops) || hops.length !== Math.max(0, tracks.length - 1) ||
    !hops.every((h) => h === null || (typeof h === "string" && PAGE_ID.test(h)))
  ) {
    return "hops は 曲数 − 1 個の、繋ぎID か null の配列で送ってください";
  }
  return { name, date, memo, trackRbIds: tracks as string[], hops: hops as (string | null)[] };
}

export async function GET() {
  if (!hasDb("playlists")) return notSetUp();
  return Response.json({ playlists: await listPlaylists() });
}

/** `id` があれば上書き、無ければ新規 */
export async function POST(request: Request) {
  if (!hasDb("playlists")) return notSetUp();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const input = parse(body);
  if (typeof input === "string") return Response.json({ error: input }, { status: 400 });
  const id = typeof body?.id === "string" && body.id ? body.id : undefined;
  const playlist = await savePlaylist(input, id);
  if (!playlist) return notFound();
  return Response.json({ playlist });
}

export async function DELETE(request: Request) {
  if (!hasDb("playlists")) return notSetUp();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id が要ります" }, { status: 400 });
  if (!(await deletePlaylist(id))) return notFound();
  return Response.json({ ok: true });
}
