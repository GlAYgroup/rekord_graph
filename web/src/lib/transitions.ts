import "server-only";
import { revalidateTag } from "next/cache";
import { DB, NOTION_TAG, request, type NotionPage } from "./notion";

/**
 * 🔀Transitions への書き込み。アプリの入力画面だけが呼ぶ。
 *
 * **人が入力する先はこの DB だけ**（🎵Tracks / 📍Cues は rekordbox の鏡なので触らない）。
 * 曲とキューの関連はアプリが持っている実データから選ばせるので、
 * 手打ちのときのように記号がズレることが原理的に起きない。
 */

export type NewTransition = {
  fromTrackId: string;
  fromCueId: string;
  toTrackId: string;
  toCueId: string;
  title: string;
  comment?: string;
  technique?: string | null;
  bars?: number | null;
  rating?: string | null;
  chain?: string;
  order?: number | null;
};

const textProp = (s: string) => ({ rich_text: s ? [{ type: "text", text: { content: s.slice(0, 1900) } }] : [] });
const selectProp = (s?: string | null) => ({ select: s ? { name: s } : null });
const relProp = (id: string) => ({ relation: [{ id }] });

/** 作成と更新で同じ組み立てを使う（片方だけ直して食い違うのを防ぐ） */
function properties(t: NewTransition) {
  return {
    つなぎ: { title: [{ type: "text", text: { content: t.title.slice(0, 200) } }] },
    From曲: relProp(t.fromTrackId),
    Fromキュー: relProp(t.fromCueId),
    To曲: relProp(t.toTrackId),
    Toキュー: relProp(t.toCueId),
    コメント: textProp(t.comment ?? ""),
    チェーン: textProp(t.chain ?? ""),
    種類: selectProp(t.technique),
    評価: selectProp(t.rating),
    小節数: { number: t.bars ?? null },
    順番: { number: t.order ?? null },
    // キューは実データから選ばせているので、記号ズレの心配が無い = OK
    同期ステータス: selectProp("OK"),
  };
}

export async function createTransition(t: NewTransition): Promise<{ id: string; url?: string }> {
  const page = await request<NotionPage & { url?: string }>("/pages", {
    method: "POST",
    fresh: true,
    body: {
      parent: { database_id: DB.transitions },
      // 出典 = どこから来た行か。移行分（完全版）と区別が付くようにする。作成時だけ入れる
      properties: { ...properties(t), 出典: textProp("アプリ") },
    },
  });

  // 5分キャッシュを待たずにグラフ・曲ページへ反映させる（次に開いた時点で取り直す）
  revalidateTag(NOTION_TAG, { expire: 0 });
  return { id: page.id, url: (page as { url?: string }).url };
}

/**
 * 繋ぎを直す。曲・キューの付け替えも含めて、入力画面と同じ選択肢から差し替える。
 * 出典は触らない（どこから来た行かの記録なので、編集しても変わらない）。
 */
export async function updateTransition(id: string, t: NewTransition): Promise<void> {
  await request(`/pages/${id}`, { method: "PATCH", body: { properties: properties(t) }, fresh: true });
  revalidateTag(NOTION_TAG, { expire: 0 });
}

/**
 * 繋ぎを消す。Notion の作法に合わせてアーカイブする（完全削除はしない）。
 * 消したい繋ぎは「間違って入れた」ものなので、戻せる方が安全。
 */
export async function deleteTransition(id: string): Promise<void> {
  await request(`/pages/${id}`, { method: "PATCH", body: { archived: true }, fresh: true });
  revalidateTag(NOTION_TAG, { expire: 0 });
}

/**
 * 評価（星）だけを直す。グラフ・曲ページから1タップで変えるための軽い経路。
 *
 * **`properties()` は通さない。** あれは全項目を書くので、
 * 星だけ変えたつもりでコメント・チェーン・種類・小節数が消える。
 * Notion の PATCH は送ったプロパティだけを更新するので、1つだけ送る。
 */
export async function updateTransitionRating(id: string, rating: string | null): Promise<void> {
  await request(`/pages/${id}`, {
    method: "PATCH",
    body: { properties: { 評価: selectProp(rating) } },
    fresh: true,
  });
  revalidateTag(NOTION_TAG, { expire: 0 });
}

/**
 * 要練習マークだけを付け外しする。星と同じ1タップ経路（`properties()` は通さない）。
 *
 * 「要練習」列が Notion にまだ無ければ、**最初のマークのときにアプリが生やす**
 * （📍Cues のループ列を sync が生やすのと同じ流儀。人が Notion を触らずに済む）。
 */
export async function updateTransitionPractice(id: string, practice: boolean): Promise<void> {
  const write = () =>
    request(`/pages/${id}`, {
      method: "PATCH",
      body: { properties: { 要練習: { checkbox: practice } } },
      fresh: true,
    });
  try {
    await write();
  } catch {
    await request(`/databases/${DB.transitions}`, {
      method: "PATCH",
      body: { properties: { 要練習: { checkbox: {} } } },
      fresh: true,
    });
    await write();
  }
  revalidateTag(NOTION_TAG, { expire: 0 });
}
