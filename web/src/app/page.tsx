import { getGraph } from "@/lib/graph";
import { longestRouteFrom } from "@/lib/route";
import { TrackSearch, type SearchTrack } from "@/components/TrackSearch";

export default async function Home() {
  const g = await getGraph();
  const tracks: SearchTrack[] = g.tracks.map((t) => {
    const cues = g.cuesByTrack.get(t.id) ?? [];
    const totalMs = (t.durationSec ?? 0) * 1000;
    return {
      id: t.id, name: t.name, fullTitle: t.fullTitle, alias: t.alias,
      bpm: t.bpm, musicalKey: t.musicalKey,
      out: g.outgoing.get(t.id)?.length ?? 0,
      in: g.incoming.get(t.id)?.length ?? 0,
      // グラフ・曲ページと同じ数え方（起点の曲を含む）。ここだけ違うと別の指標に見える
      maxFrom: longestRouteFrom(g, t.id).trackIds.length,
      ticks: totalMs
        ? cues.map((c) => Math.min(99, ((c.positionMs ?? 0) / totalMs) * 100))
        : [],
    };
  });

  return (
    <main className="relative z-1 mx-auto max-w-6xl px-4 lg:px-8">
      <TrackSearch tracks={tracks} />
    </main>
  );
}
