import { PlaylistIndex } from "@/components/PlaylistIndex";
import { getGraph } from "@/lib/graph";
import { hasDb } from "@/lib/notion";
import { listPlaylists } from "@/lib/playlists";

export const metadata = { title: "プレイリスト | rekord_graph" };
// 保存した直後に開くので、キャッシュさせない
export const dynamic = "force-dynamic";

/**
 * イベントごとのプレイリストの一覧。中身は Notion の 🎶Playlists。
 * DB が設定されていなければ（Vercel の環境変数がまだ等）、他の画面は壊さずここで未設定と言う。
 */
export default async function PlaylistsPage() {
  if (!hasDb("playlists")) {
    return (
      <main className="relative z-1 mx-auto max-w-2xl px-4 pb-nav pt-4">
        <h1 className="text-[22px] font-bold tracking-tight">プレイリスト</h1>
        <p className="mt-3 rounded-card border border-warn/40 bg-warn/10 p-4 text-[14px] text-warn">
          🎶Playlists の DB がまだ設定されていません。環境変数 NOTION_DB_PLAYLISTS
          （ローカルなら ~/.config/rekord_graph/config.json の notion.databases.playlists）を置いてください。
        </p>
      </main>
    );
  }
  const [g, playlists] = await Promise.all([getGraph(), listPlaylists()]);
  return <PlaylistIndex playlists={playlists} tracks={g.tracks} />;
}
