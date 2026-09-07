import { getGraph } from "@/lib/graph";
import { createTransition, deleteTransition, updateTransition } from "@/lib/transitions";

/** 入力画面から 🔀Transitions に1行足す。 */
export const dynamic = "force-dynamic";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** 数値そのものでも、フォームが送る文字列でも受ける。空・数でないものは null */
const numOrNull = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = str(v);
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * 送られてきた ID が実在し、キューがその曲のものかを必ずサーバで確かめる。
 * ここを信じて書くと、別の曲のキューを指した壊れた行が Notion に残る。
 */
async function validated(body: Record<string, unknown> | null) {
  const fromTrackId = str(body?.fromTrackId);
  const fromCueId = str(body?.fromCueId);
  const toTrackId = str(body?.toTrackId);
  const toCueId = str(body?.toCueId);
  if (!fromTrackId || !fromCueId || !toTrackId || !toCueId) {
    return { error: "From/To の曲とキューが要ります", status: 400 as const };
  }

  const g = await getGraph();
  const from = g.trackById.get(fromTrackId);
  const to = g.trackById.get(toTrackId);
  const fromCue = g.cueById.get(fromCueId);
  const toCue = g.cueById.get(toCueId);
  if (!from || !to || !fromCue || !toCue) {
    return { error: "知らない曲かキューです", status: 400 as const };
  }
  if (fromCue.trackId !== fromTrackId || toCue.trackId !== toTrackId) {
    return { error: "キューがその曲のものではありません", status: 400 as const };
  }

  // 小節数の「前」と「後」は排他。入力画面が片方を塞いでいるので普通は届かないが、
  // 両方入った行を作ると「何小節前か」の答えが2つある状態になるので、ここで弾く
  const bars = numOrNull(body?.bars);
  const barsAfter = numOrNull(body?.barsAfter);
  if (bars != null && barsAfter != null) {
    return { error: "小節数は「前」か「後」のどちらか片方だけ入れてください", status: 400 as const };
  }

  return {
    graph: g,
    payload: {
      fromTrackId, fromCueId, toTrackId, toCueId,
      title: `${from.name} → ${to.name}`,
      comment: str(body?.comment),
      chain: str(body?.chain),
      technique: str(body?.technique) || null,
      rating: str(body?.rating) || null,
      bars,
      barsAfter,
      practice: body?.practice === true,
      order: numOrNull(body?.order),
    },
  };
}

export async function POST(request: Request) {
  const v = await validated(await request.json().catch(() => null));
  if ("error" in v) return Response.json({ error: v.error }, { status: v.status });

  const created = await createTransition(v.payload);
  return Response.json({ ok: true, id: created.id, url: created.url });
}

/** 既存の繋ぎを直す。曲・キューの付け替えも同じ画面からできる。 */
export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  const id = str(body?.id);
  if (!id) return Response.json({ error: "id が要ります" }, { status: 400 });

  const v = await validated(body);
  if ("error" in v) return Response.json({ error: v.error }, { status: v.status });
  if (!v.graph.transitions.some((t) => t.id === id)) {
    return Response.json({ error: "その繋ぎは見つかりません" }, { status: 404 });
  }

  await updateTransition(id, v.payload);
  return Response.json({ ok: true, id });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id が要ります" }, { status: 400 });

  // 存在する繋ぎか確かめてから消す（知らない ID で他のページを消さない）
  const g = await getGraph();
  if (!g.transitions.some((t) => t.id === id)) {
    return Response.json({ error: "その繋ぎは見つかりません" }, { status: 404 });
  }
  await deleteTransition(id);
  return Response.json({ ok: true });
}
