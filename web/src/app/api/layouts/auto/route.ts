import { getGraph } from "@/lib/graph";
import { computeLayout } from "@/lib/layout";

/**
 * 自動配置の座標。**グラフ画面が「自動」を開いたときと「配置を更新」を押したときだけ**叩く。
 *
 * 以前は /graph を開くたびにサーバで計算していたが、繋ぎが1本増えるたびに計算し直しになり
 * （実測 2026-10-03: 547曲・150繋ぎで約1.3秒）、保存したパターンを開いている間は使われもしなかった。
 * 計算は今まで通りサーバ（全端末で同じ形）。同じ曲・同じ繋ぎなら `computeLayout` のキャッシュが返す
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const g = await getGraph();
  const layout = computeLayout(
    g.tracks.map((t) => ({ id: t.id, label: t.name })),
    g.transitions.map((t) => ({ id: t.id, source: t.fromTrackId, target: t.toTrackId })),
  );
  // ブラウザに残させない（繋ぎが増えたあとの「配置を更新」で、前の形が返ってこないように）
  return Response.json({ layout }, { headers: { "Cache-Control": "no-store" } });
}
