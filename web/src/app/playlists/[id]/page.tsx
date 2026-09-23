import { notFound } from "next/navigation";
import { PlaylistEditor } from "@/components/PlaylistEditor";
import { getGraph } from "@/lib/graph";
import { getPlaylist } from "@/lib/playlists";

export const metadata = { title: "プレイリスト | rekord_graph" };
export const dynamic = "force-dynamic";

/** 1本のプレイリストを開いて、並べ替え・曲の足し引き・/play を始める画面 */
export default async function PlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [playlist, g] = await Promise.all([getPlaylist(id), getGraph()]);
  if (!playlist) notFound();
  return (
    <PlaylistEditor
      // 保存後の refresh では作り直さない（下書きと「保存しました」を残す。比べる相手の props は新しくなる）
      key={playlist.id}
      playlist={playlist}
      tracks={g.tracks}
      cues={[...g.cueById.values()]}
      transitions={g.transitions}
    />
  );
}
