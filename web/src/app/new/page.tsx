import { TransitionForm, type FormTrack } from "@/components/TransitionForm";
import { cueLabel } from "@/lib/format";
import { getGraph } from "@/lib/graph";

export const metadata = { title: "繋ぎを追加 | rekord_graph" };

const param = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/**
 * 繋ぎの入力画面。
 *
 * Notion のリレーションは候補を他プロパティで絞れないので、
 * 「From曲を選んだらその曲のキューだけ出す」はアプリ側でしか作れない。
 *
 * `?from=` / `?to=` で曲を指定して開ける（曲ページ・グラフの「繋ぎを追加」から来る）。
 * `?edit=<繋ぎID>` なら、その繋ぎを読み込んだ**編集モード**で開く
 * （曲ページ・グラフの「編集」から来る。どのキュー同士を結ぶかをここで付け替える）。
 * 知らない ID は 404 にせず、ただ選ばれていない状態で開く — 前もって選んだ曲は
 * 表示の都合でしかなく、実際の書き込みは API 側で必ず検証しているため。
 */
export default async function NewTransitionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const g = await getGraph();

  const tracks: FormTrack[] = g.tracks.map((t) => ({
    id: t.id,
    name: t.name,
    bpm: t.bpm,
    musicalKey: t.musicalKey,
    cues: g.cuesByTrack.get(t.id) ?? [],
  }));

  const initialFromId = param(sp.from);
  const initialToId = param(sp.to);
  // 知らない ID は無視する（消された繋ぎのリンクを踏んでも、ただの新規入力として開く）
  const editId = param(sp.edit);
  const initialEditId = editId && g.transitions.some((t) => t.id === editId) ? editId : undefined;

  // 同じ4点を指す行が既にあるか（重複の注意書き用）
  const existing = g.transitions.map(
    (t) => `${t.fromTrackId}|${t.fromCueId}|${t.toTrackId}|${t.toCueId}`,
  );
  const chains = [...new Set(g.transitions.map((t) => t.chain).filter(Boolean))].sort();

  // 登録済みの繋ぎ（消せるように一覧で出す）。**新しいものが上**。
  // 作成時刻で並べる: Notion の返す順に保証は無く、入れた直後の1行が
  // 一覧のどこに出るか分からないと「保存できたのか」がその場で読めない
  const cue = (id: string) => cueLabel(g.cueById.get(id));
  const list = [...g.transitions]
    .sort((a, b) => b.createdTime.localeCompare(a.createdTime))
    .map((t) => ({
      id: t.id,
      from: g.trackById.get(t.fromTrackId)?.name ?? "?",
      to: g.trackById.get(t.toTrackId)?.name ?? "?",
      fromBpm: g.trackById.get(t.fromTrackId)?.bpm ?? null,
      toBpm: g.trackById.get(t.toTrackId)?.bpm ?? null,
      fromCue: cue(t.fromCueId),
      toCue: cue(t.toCueId),
      comment: t.comment,
      // 編集でフォームに戻すための素の値
      fromTrackId: t.fromTrackId,
      fromCueId: t.fromCueId,
      toTrackId: t.toTrackId,
      toCueId: t.toCueId,
      technique: t.technique,
      rating: t.rating,
      bars: t.bars,
      barsAfter: t.barsAfter,
      practice: t.practice,
      chain: t.chain,
    }));

  return (
    <TransitionForm
      // 曲ページ / グラフから続けて開くと同じ要素が使い回され、
      // 初期値（useState の第一引数）が読み直されない。key で作り直す。
      // **この3つを history.replaceState で書き換えないこと** — サーバが描いたときと違う URL の
      // まま router.refresh() が走ると key が変わり、入力中のフォームが作り直されて消える
      // （URL を変えるときは router.replace。TransitionForm の startNew を参照）
      key={`${initialFromId ?? ""}|${initialToId ?? ""}|${initialEditId ?? ""}`}
      tracks={tracks}
      existing={existing}
      chains={chains}
      transitions={list}
      initialFromId={initialFromId}
      initialToId={initialToId}
      initialEditId={initialEditId}
    />
  );
}
