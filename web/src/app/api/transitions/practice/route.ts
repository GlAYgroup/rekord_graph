import { getGraph } from "@/lib/graph";
import { updateTransitionPractice } from "@/lib/transitions";

/**
 * 要練習マークだけを付け外しする。星（`/api/transitions/rating`）と同じ、
 * グラフ・曲ページ・練習一覧から1タップで押すための軽い入口。
 */
export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) return Response.json({ error: "id が要ります" }, { status: 400 });
  if (typeof body?.practice !== "boolean") {
    return Response.json({ error: "practice は true / false で送ってください" }, { status: 400 });
  }

  const g = await getGraph();
  if (!g.transitions.some((t) => t.id === id)) {
    return Response.json({ error: "その繋ぎは見つかりません" }, { status: 404 });
  }

  await updateTransitionPractice(id, body.practice);
  return Response.json({ ok: true, id, practice: body.practice });
}
