import { deletePattern, listPatterns, renamePattern, savePattern } from "@/lib/patterns";

/**
 * 配置パターンの保存先。グラフ画面の「保存」ボタンだけが叩く。
 *
 * 端末に保存せずここを通すのは、PC で整えた形をスマホでもそのまま開くため。
 * 書き込むのは 🗺️Layouts DB だけで、rekordbox の鏡（🎵Tracks / 📍Cues）には触らない。
 */

// 保存した直後に一覧を読み直すので、キャッシュさせない
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ patterns: await listPatterns() });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const positions = body?.positions;
  if (!name || !positions || typeof positions !== "object") {
    return Response.json({ error: "name と positions が要ります" }, { status: 400 });
  }
  const id = typeof body?.id === "string" ? body.id : undefined;
  const pattern = await savePattern(name, positions, id);
  return Response.json({ pattern, patterns: await listPatterns() });
}

/** 名前だけを変える（配置は書かない） */
export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!id || !name) {
    return Response.json({ error: "id と name が要ります" }, { status: 400 });
  }
  const pattern = await renamePattern(id, name);
  return Response.json({ pattern, patterns: await listPatterns() });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id が要ります" }, { status: 400 });
  await deletePattern(id);
  return Response.json({ patterns: await listPatterns() });
}
