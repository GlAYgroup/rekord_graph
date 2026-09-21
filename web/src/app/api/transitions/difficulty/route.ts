import { asDifficulty } from "@/lib/difficulty";
import { getGraph } from "@/lib/graph";
import { updateTransitionDifficulty } from "@/lib/transitions";

/**
 * 難易度だけを付け替える。入力画面の一括編集から1タップで押すための入口
 * （星の `/api/transitions/rating` と同じ形。繋ぎ全体の編集は `/api/transitions` の PATCH）。
 */
export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) return Response.json({ error: "id が要ります" }, { status: 400 });

  // 知らない文字列を通すと Notion の select に揺れた選択肢が生える。正本の配列だけを許す
  const raw = body?.difficulty;
  const difficulty = raw == null || raw === "" ? null : asDifficulty(raw);
  if (raw != null && raw !== "" && difficulty === null) {
    return Response.json({ error: "知らない難易度です" }, { status: 400 });
  }

  const g = await getGraph();
  if (!g.transitions.some((t) => t.id === id)) {
    return Response.json({ error: "その繋ぎは見つかりません" }, { status: 404 });
  }

  await updateTransitionDifficulty(id, difficulty);
  return Response.json({ ok: true, id, difficulty });
}
