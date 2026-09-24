import { notFound } from "next/navigation";
import { PlaylistPlayer } from "@/components/PlaylistPlayer";
import { getGraph } from "@/lib/graph";
import { getPlaylist } from "@/lib/playlists";

export const metadata = { title: "プレイ | rekord_graph" };
export const dynamic = "force-dynamic";

/**
 * プレイリストの**決めた順だけ**をたどるプレイ画面。/play（今の曲から行ける繋ぎを全部並べる）とは別物で、
 * ここは「今の曲 → このプレイリストの次の曲」の繋ぎ1本だけを出す
 */
export default async function PlaylistPlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [playlist, g] = await Promise.all([getPlaylist(id), getGraph()]);
  if (!playlist) notFound();
  return (
    <PlaylistPlayer
      playlist={playlist}
      tracks={g.tracks}
      cues={[...g.cueById.values()]}
      transitions={g.transitions}
    />
  );
}
