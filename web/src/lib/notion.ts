import "server-only";
import fs from "node:fs";
import os from "node:os";

/**
 * Notion API への唯一の出口。外部サービスはここだけに閉じ込める（差し替え可能にしておく）。
 * トークンは絶対にクライアントへ出さない。NEXT_PUBLIC_ を付けないこと。
 */

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

/**
 * 設定の在り処（上が優先）:
 *   1. 環境変数 NOTION_TOKEN / NOTION_DB_TRACKS / NOTION_DB_CUES / NOTION_DB_TRANSITIONS / NOTION_DB_LAYOUTS
 *      （Vercel ではこれを使う）
 *   2. ~/.config/rekord_graph/config.json（ローカル開発。tools/ と同じファイル。`tools/setup_notion.py` が書く）
 *   3. ~/.config/rekord_graph/notion_token（トークンだけ）
 * Notion の ID は人ごとに違うので、コードには書かない。
 */
type LocalConfig = {
  notion?: { token?: string; databases?: Partial<Record<DbKey, string>> };
};

let localConfigCache: LocalConfig | null | undefined;

/** ローカルの設定ファイル。無ければ null（本番は環境変数だけで動く）。 */
function localConfig(): LocalConfig | null {
  if (localConfigCache !== undefined) return localConfigCache;
  try {
    const dir = process.env.REKORD_GRAPH_CONFIG_DIR || `${os.homedir()}/.config/rekord_graph`;
    localConfigCache = JSON.parse(fs.readFileSync(`${dir}/config.json`, "utf8")) as LocalConfig;
  } catch {
    localConfigCache = null;
  }
  return localConfigCache;
}

export type DbKey = "tracks" | "cues" | "transitions" | "layouts";

function dbId(key: DbKey): string {
  const id = process.env[`NOTION_DB_${key.toUpperCase()}`] || localConfig()?.notion?.databases?.[key];
  if (!id) {
    throw new Error(
      `Notion の database ID（${key}）が設定されていません。` +
        `環境変数 NOTION_DB_${key.toUpperCase()} か ~/.config/rekord_graph/config.json に置いてください（README「セットアップ」）`,
    );
  }
  return id;
}

/**
 * 🎵Tracks / 📍Cues / 🔀Transitions / 🗺️Layouts の database ID。
 * 🗺️Layouts と 🔀Transitions だけがこのアプリの書き込み先。
 * 🎵Tracks / 📍Cues は rekordbox の鏡なので書かない（書くと sync.py と喧嘩する）。
 */
export const DB = {
  get tracks() { return dbId("tracks"); },
  get cues() { return dbId("cues"); },
  get transitions() { return dbId("transitions"); },
  get layouts() { return dbId("layouts"); },
};

/** Notion の更新をどれくらいで拾うか。DJ 練習後に書いて数分で反映されれば十分。 */
export const REVALIDATE_SECONDS = 300;

/**
 * 読み取りキャッシュのタグ。アプリからトランジションを1件書いたら
 * `revalidateTag(NOTION_TAG)` で捨てる（5分待たずにグラフへ出す）。
 */
export const NOTION_TAG = "notion";

function token(): string {
  const fromEnv = process.env.NOTION_TOKEN;
  if (fromEnv) return fromEnv;
  const fromConfig = localConfig()?.notion?.token;
  if (fromConfig) return fromConfig;
  // ローカル開発の便宜。本番（Vercel）では必ず環境変数を使う。
  try {
    const dir = process.env.REKORD_GRAPH_CONFIG_DIR || `${os.homedir()}/.config/rekord_graph`;
    return fs.readFileSync(`${dir}/notion_token`, "utf8").trim();
  } catch {
    throw new Error("NOTION_TOKEN が設定されていません（README「セットアップ」）");
  }
}

export type NotionPage = {
  id: string;
  properties: Record<string, any>;
  created_time?: string;
  last_edited_time?: string;
};

/**
 * Notion API への生アクセス。
 * `fresh: true` はキャッシュを通さない（保存した直後に読み直す配置パターン用）。
 */
export async function request<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; fresh?: boolean } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Notion-Version": VERSION,
      "Content-Type": "application/json",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.fresh
      ? { cache: "no-store" as const }
      : { next: { revalidate: REVALIDATE_SECONDS, tags: [NOTION_TAG] } }),
  });
  if (!res.ok) throw new Error(`Notion ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function queryPage(dbId: string, cursor?: string, fresh?: boolean) {
  return request<{ results: NotionPage[]; has_more: boolean; next_cursor: string | null }>(
    `/databases/${dbId}/query`,
    { method: "POST", body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, fresh },
  );
}

/** データベースの全行を取得する（ページネーション込み）。 */
export async function queryAll(dbId: string, fresh?: boolean): Promise<NotionPage[]> {
  const out: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryPage(dbId, cursor, fresh);
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (cursor);
  return out;
}

/** title / rich_text プロパティを素のテキストにする。 */
export function text(prop: any): string {
  const items = prop?.rich_text ?? prop?.title ?? [];
  return items.map((i: any) => i.plain_text ?? "").join("").trim();
}

export const selectName = (prop: any): string | null => prop?.select?.name ?? null;
export const num = (prop: any): number | null => prop?.number ?? null;
export const relIds = (prop: any): string[] => (prop?.relation ?? []).map((r: any) => r.id);
