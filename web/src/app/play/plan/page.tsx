import { SetPlanner } from "@/components/SetPlanner";
import { getGraph } from "@/lib/graph";

export const metadata = { title: "セットを組む | rekord_graph" };

/**
 * セットを組む = **入れたい曲を選ぶと、それをなるべく多く通る道筋を出す画面。**
 *
 * 選んだ曲も道筋も端末（`lib/playlog.ts`）だけが持つ。探索は選ぶたびに端末で回す
 * （`lib/route.ts` の `planRoute`）。サーバは素材を渡すだけ。
 */
export default async function PlanPage() {
  const g = await getGraph();
  return (
    <SetPlanner
      tracks={g.tracks}
      cues={[...g.cueById.values()]}
      transitions={g.transitions}
    />
  );
}
