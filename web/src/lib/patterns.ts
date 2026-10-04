import "server-only";
import { DB, isNotFound, queryAll, request, text, type NotionPage } from "./notion";

/**
 * グラフの配置パターン（「パターン1」「パターン2」…）の保存と読み出し。
 *
 * 置き場所は Notion の 🗺️Layouts DB。**端末に保存しない**のが肝で、
 * PC で整えた形をスマホでそのまま開けるのはこのため
 * （localStorage に置いていた頃、端末ごとに別の形が育ってしまった）。
 *
 * 座標のキーは **rekordbox の ContentID**。Notion のページIDではないので、
 * Notion 側を作り直しても保存した形は生き残る。
 */

export type Pattern = {
  id: string;
  name: string;
  /** rekordboxID -> 座標 */
  positions: Record<string, { x: number; y: number }>;
};

/** Notion の rich_text は1要素 2000 文字まで。余裕を見て刻む */
const CHUNK = 1900;

/** `<rekordboxID>:<x>:<y>` を空白区切りで並べただけの形式。目で読めて、短い */
function encode(positions: Record<string, { x: number; y: number }>): string {
  return Object.entries(positions)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, p]) => `${id}:${Math.round(p.x)}:${Math.round(p.y)}`)
    .join(" ");
}

function decode(raw: string): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const token of raw.split(/\s+/)) {
    if (!token) continue;
    const [id, x, y] = token.split(":");
    const nx = Number(x), ny = Number(y);
    if (!id || !Number.isFinite(nx) || !Number.isFinite(ny)) continue; // 壊れた行は捨てる
    out[id] = { x: nx, y: ny };
  }
  return out;
}

function toPattern(page: NotionPage): Pattern {
  return {
    id: page.id,
    name: text(page.properties["名前"]) || "無題",
    positions: decode(text(page.properties["配置"])),
  };
}

/** 新しく保存したものが先頭。アプリはこの先頭を既定の形として開く */
export async function listPatterns(): Promise<Pattern[]> {
  // 全ページ読む（1ページで切ると、51個目より古いパターンが一覧から消え、名前の重なりも見落とす）
  const pages = await queryAll(DB.layouts, true, [{ timestamp: "last_edited_time", direction: "descending" }]);
  return pages.map(toPattern);
}

/** Notion の ID はダッシュの有無・大文字小文字が揺れるので、揃えてから比べる */
const normId = (id: string) => id.replace(/-/g, "").toLowerCase();

/**
 * `id` が 🗺️Layouts の（捨てていない）行か。**ID で書く前に必ず通す。**
 * ID はリクエストから来るので、確かめないと 🔀Transitions の行でも名前の上書きや
 * アーカイブができてしまう。読めない ID も「違う」に倒す（確かめられないものには書かない）。
 */
async function isLayoutPage(id: string): Promise<boolean> {
  const page = await request<{ parent?: { database_id?: string }; archived?: boolean }>(
    `/pages/${encodeURIComponent(id)}`, { fresh: true },
  ).catch((e) => {
    // 「無い」と言い切れるときだけ「違う」に倒す。混んでいる（429）・回線の失敗は投げ直す
    // （false にすると API が 404 を返し、画面は消されたパターンだと思って自動配置へ戻る）
    if (isNotFound(e)) return null;
    throw e;
  });
  return !!page && !page.archived && normId(page.parent?.database_id ?? "") === normId(DB.layouts);
}

/**
 * 他のパターンが使っていない名前にする（`パターン3` が既にあれば `パターン3 (2)`）。
 * 名前で選ぶ画面なので、同じ名前が2つあるとどちらを開くのか分からない。画面は手元の一覧から
 * 「次の名前」を決めるので、他の端末で作られた分や、作成の返事を待つ間の2回目の保存で重なりうる
 */
export async function freeName(name: string, exceptId?: string): Promise<string> {
  const taken = new Set((await listPatterns()).filter((p) => p.id !== exceptId).map((p) => p.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

function properties(name: string, positions: Pattern["positions"]) {
  const blob = encode(positions);
  const chunks: string[] = [];
  for (let i = 0; i < blob.length; i += CHUNK) chunks.push(blob.slice(i, i + CHUNK));
  return {
    名前: { title: [{ type: "text", text: { content: name.slice(0, 100) } }] },
    配置: { rich_text: chunks.map((c) => ({ type: "text", text: { content: c } })) },
    曲数: { number: Object.keys(positions).length },
  };
}

/** `id` を渡せば上書き、渡さなければ新規作成。`id` が 🗺️Layouts の行でなければ何も書かず null */
export async function savePattern(
  name: string,
  positions: Pattern["positions"],
  id?: string,
): Promise<Pattern | null> {
  if (id && !(await isLayoutPage(id))) return null;
  // 新規だけ名前の重なりを避ける（上書きは今の名前のまま書く）
  const props = properties(id ? name : await freeName(name), positions);
  const page = id
    ? await request<NotionPage>(`/pages/${id}`, { method: "PATCH", body: { properties: props }, fresh: true })
    : await request<NotionPage>("/pages", {
        method: "POST",
        body: { parent: { database_id: DB.layouts }, properties: props },
        fresh: true,
      });
  return toPattern(page);
}

/**
 * 名前だけを変える。**配置には触らない**（`savePattern` は全列を書くので、
 * そちらで名前を変えると、画面に出ている途中の形で座標まで上書きしてしまう）。
 * `id` が 🗺️Layouts の行でなければ何も書かず null。
 */
export async function renamePattern(id: string, name: string): Promise<Pattern | null> {
  if (!(await isLayoutPage(id))) return null;
  const page = await request<NotionPage>(`/pages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { properties: { 名前: { title: [{ type: "text", text: { content: name.slice(0, 100) } }] } } },
    fresh: true,
  });
  return toPattern(page);
}

/**
 * Notion の作法に合わせてアーカイブする（完全削除はしない。戻せる方が安全）。
 * `id` が 🗺️Layouts の行でなければ何もせず false。
 */
export async function deletePattern(id: string): Promise<boolean> {
  if (!(await isLayoutPage(id))) return false;
  await request(`/pages/${id}`, { method: "PATCH", body: { archived: true }, fresh: true });
  return true;
}
