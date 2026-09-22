import { isTransition, updateTransitionComment } from "@/lib/transitions";

/**
 * コメントだけを書き換える。`/play` の下見中に、カードの下からその場で書き足すための入口。
 * （繋ぎ全体の編集は `/api/transitions` の PATCH。あちらは全項目を書き換える）
 */
export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) return Response.json({ error: "id が要ります" }, { status: 400 });
  // 空文字は「コメントを消す」。文字列以外は受けない（null を空として黙って消さない）
  if (typeof body?.comment !== "string") {
    return Response.json({ error: "comment は文字列で送ってください" }, { status: 400 });
  }
  // 前後の空白だけ落とす（入力画面の保存と同じ）。途中の改行はそのまま残す
  const comment = body.comment.trim();

  // 1行だけ読んで確かめる（全件を読み直すと、続けて押したときに Notion の上限に当たる）
  if (!(await isTransition(id))) {
    return Response.json({ error: "その繋ぎは見つかりません" }, { status: 404 });
  }

  await updateTransitionComment(id, comment);
  return Response.json({ ok: true, id, comment });
}
