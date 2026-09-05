import { getGraph } from "@/lib/graph";
import { RATINGS } from "@/lib/ratings";
import { updateTransitionRating } from "@/lib/transitions";

/**
 * 星だけを付け替える。グラフ・曲ページから1タップで押せるようにするための入口。
 * （繋ぎ全体の編集は `/api/transitions` の PATCH。あちらは全項目を書き換える）
 */
export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const raw = body?.rating;
  if (!id) return Response.json({ error: "id が要ります" }, { status: 400 });

  // 知らない文字列を通すと Notion の select に揺れた選択肢が生える。正本の配列だけを許す
  const rating = raw == null || raw === "" ? null : String(raw);
  if (rating !== null && !RATINGS.includes(rating as (typeof RATINGS)[number])) {
    return Response.json({ error: "知らない評価です" }, { status: 400 });
  }

  const g = await getGraph();
  if (!g.transitions.some((t) => t.id === id)) {
    return Response.json({ error: "その繋ぎは見つかりません" }, { status: 404 });
  }

  await updateTransitionRating(id, rating);
  return Response.json({ ok: true, id, rating });
}
