import { asDifficulty } from "@/lib/difficulty";
import { LOOP_TECHNIQUE } from "@/lib/format";
import { getGraph } from "@/lib/graph";
import { RATINGS } from "@/lib/ratings";
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
  // キューは任意（曲とメモだけでも残せる）。送られてきたキューだけを確かめる
  if (!fromTrackId || !toTrackId) {
    return { error: "From/To の曲が要ります", status: 400 as const };
  }

  const g = await getGraph();
  const from = g.trackById.get(fromTrackId);
  const to = g.trackById.get(toTrackId);
  const fromCue = fromCueId ? g.cueById.get(fromCueId) : null;
  const toCue = toCueId ? g.cueById.get(toCueId) : null;
  if (!from || !to || fromCue === undefined || toCue === undefined) {
    return { error: "知らない曲かキューです", status: 400 as const };
  }
  if ((fromCue && fromCue.trackId !== fromTrackId) || (toCue && toCue.trackId !== toTrackId)) {
    return { error: "キューがその曲のものではありません", status: 400 as const };
  }

  // 小節数の「前」と「後」は排他。入力画面が片方を塞いでいるので普通は届かないが、
  // 両方入った行を作ると「何小節前か」の答えが2つある状態になるので、ここで弾く
  const bars = numOrNull(body?.bars);
  const barsAfter = numOrNull(body?.barsAfter);
  if (bars != null && barsAfter != null) {
    return { error: "小節数は「前」か「後」のどちらか片方だけ入れてください", status: 400 as const };
  }
  // 評価は正本の配列だけを許す（`/api/transitions/rating` と同じ。揺れた選択肢を Notion に生やさない）
  const rating = str(body?.rating) || null;
  if (rating !== null && !RATINGS.includes(rating as (typeof RATINGS)[number])) {
    return { error: "知らない評価です", status: 400 as const };
  }
  // 小節数は「To キューの何小節前／後」。基準のキューが無いと意味を持たない
  if (!toCue && (bars != null || barsAfter != null)) {
    return { error: "小節数は To のキューを選んだときだけ入れられます", status: 400 as const };
  }

  // ループ小節数は「ループ合わせ」のときだけ。前と後は**両方入ってよい**（小節数の前／後とは違って排他ではない）
  const technique = str(body?.technique) || null;
  const loopBefore = numOrNull(body?.loopBefore);
  const loopAfter = numOrNull(body?.loopAfter);
  if ((loopBefore != null || loopAfter != null) && technique !== LOOP_TECHNIQUE) {
    return { error: `ループの小節数は種類が「${LOOP_TECHNIQUE}」のときだけ入れられます`, status: 400 as const };
  }
  if ((loopBefore != null && loopBefore <= 0) || (loopAfter != null && loopAfter <= 0)) {
    return { error: "ループの小節数は 0 より大きい数にしてください", status: 400 as const };
  }

  return {
    graph: g,
    payload: {
      fromTrackId, fromCueId, toTrackId, toCueId,
      title: `${from.name} → ${to.name}`,
      comment: str(body?.comment),
      chain: str(body?.chain),
      technique,
      rating,
      // 知らない値は捨てる（打ち間違いで Notion の選択肢を増やさない）
      difficulty: asDifficulty(str(body?.difficulty)),
      bars,
      barsAfter,
      loopBefore,
      loopAfter,
      practice: body?.practice === true,
      // 送られてこなければ書かない（入力画面は順番を送らない。null で上書きすると移行分の順番が消える）
      order: body && typeof body === "object" && "order" in body ? numOrNull(body.order) : undefined,
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
