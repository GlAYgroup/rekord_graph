import { PlayDeck } from "@/components/PlayDeck";
import { getGraph } from "@/lib/graph";
import { setLength, type SetLength } from "@/lib/duration";
import { longestRouteFrom } from "@/lib/route";

export const metadata = { title: "プレイ | rekord_graph" };

/**
 * プレイ画面。**スマホ片手で「次に何を繋ぐか」だけを見るための画面。**
 *
 * サーバは Notion から読んだ素材をそのまま渡すだけ。「今どこまで来たか」は
 * その場その場の話で Notion に残す物ではないので、状態は端末（client）だけが持つ。
 */
export default async function PlayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const g = await getGraph();
  const from = typeof sp.from === "string" && g.trackById.has(sp.from) ? sp.from : null;

  // 「この先最大何曲」は全曲ぶんをここで計算しておく（探索が重いので端末で全部は回さない）。
  // 本番中に「使った曲を外した数」が要る分だけ、端末が maxOnwardFrom で数え直す
  // 同じ道筋で「何分のセットになるか」も出す（曲を選ぶ一覧に添える）
  const maxFrom: Record<string, number> = {};
  const maxLength: Record<string, SetLength> = {};
  const lookup = {
    durationSec: (id: string) => g.trackById.get(id)?.durationSec ?? null,
    bpm: (id: string) => g.trackById.get(id)?.bpm ?? null,
    cueMs: (id: string) => g.cueById.get(id)?.positionMs ?? null,
  };
  for (const t of g.tracks) {
    const r = longestRouteFrom(g, t.id);
    maxFrom[t.id] = r.trackIds.length;
    maxLength[t.id] = setLength(r.trackIds, r.transitions, lookup);
  }

  return (
    <PlayDeck
      tracks={g.tracks}
      cues={[...g.cueById.values()]}
      transitions={g.transitions}
      maxFrom={maxFrom}
      maxLength={maxLength}
      initialTrackId={from}
    />
  );
}
