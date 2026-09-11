import { PlayHistory } from "@/components/PlayHistory";
import { getGraph } from "@/lib/graph";

export const metadata = { title: "プレイ履歴 | rekord_graph" };

/**
 * プレイ履歴 = **1回のセットで、どの曲からどの曲へ繋いだかの記録。**
 *
 * 中身は端末（localStorage）だけが持つ（かけてきた順と同じ性質のものなので Notion には残さない）。
 * サーバがするのは、履歴に入っている ID を曲名・キューに戻すための素材を渡すことだけ。
 */
export default async function PlayHistoryPage() {
  const g = await getGraph();
  return (
    <PlayHistory
      tracks={g.tracks}
      cues={[...g.cueById.values()]}
      transitions={g.transitions}
    />
  );
}
