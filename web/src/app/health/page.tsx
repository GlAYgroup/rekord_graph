import Link from "next/link";
import { getGraph } from "@/lib/graph";

export const metadata = { title: "状態 | rekord_graph" };

/**
 * データの健全性を見る画面。
 * rekordbox は頻繁に触るので、「アプリが黙って古い情報を出している」状態を作らないための窓。
 */
export default async function HealthPage() {
  const g = await getGraph();

  const needsReview = g.transitions.filter((t) => t.needsReview);
  const brokenCue = g.transitions.filter(
    (t) => !g.cueById.has(t.fromCueId) || !g.cueById.has(t.toCueId),
  );
  const noCues = g.tracks.filter((t) => (g.cuesByTrack.get(t.id)?.length ?? 0) === 0);
  const unnamedCues = [...g.cueById.values()].filter((c) => !c.name);
  const isolated = g.tracks.filter(
    (t) => !g.outgoing.has(t.id) && !g.incoming.has(t.id),
  );

  const rows = [
    { label: "要確認のトランジション", items: needsReview.length, tone: needsReview.length ? "warn" : "ok",
      note: "rekordbox 側の変更で、記号やキューがズレている可能性があるもの" },
    { label: "参照が壊れた繋ぎ", items: brokenCue.length, tone: brokenCue.length ? "warn" : "ok",
      note: "指しているキューが 📍Cues に見つからないもの。sync を流すと直る" },
    { label: "キューが無い曲", items: noCues.length, tone: "muted",
      note: "rekordbox でまだキューを打っていない曲" },
    { label: "名前の無いキュー", items: unnamedCues.length, tone: "muted",
      note: "記号だけのキュー。名前を付けると照合が安定する" },
    { label: "繋ぎが記録されていない曲", items: isolated.length, tone: "muted",
      note: "グラフに現れない曲" },
  ] as const;

  return (
    <>
      <main className="relative z-1 mx-auto max-w-3xl px-4 pb-nav lg:px-8">
        <header className="sticky top-0 z-20 -mx-4 border-b border-border bg-bg/85 px-4 pb-3 pt-4 backdrop-blur-md lg:-mx-8 lg:px-8">
          <h1 className="text-[26px] font-bold leading-none tracking-tight">状態</h1>
          <p className="mt-1.5 text-[13px] text-fg-muted">
            曲 {g.tracks.length} · キュー {g.cueById.size} · 繋ぎ {g.transitions.length}
          </p>
        </header>

        <ul className="mt-5 space-y-2">
          {rows.map((r) => (
            <li
              key={r.label}
              className="flex items-start gap-3 rounded-card border border-border bg-surface p-4"
            >
              <span
                className={`mt-1 size-2 shrink-0 rounded-full ${
                  r.tone === "warn" ? "bg-warn" : r.tone === "ok" ? "bg-ok" : "bg-fg-subtle/50"
                }`}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px]">{r.label}</span>
                <span className="block text-[13px] text-fg-subtle">{r.note}</span>
              </span>
              <span className="font-mono text-[20px] tabular-nums shrink-0">{r.items}</span>
            </li>
          ))}
        </ul>

        {needsReview.length > 0 && (
          <section className="mt-6">
            <h2 className="label mb-2">要確認の内訳</h2>
            <ul className="space-y-2">
              {needsReview.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/track/${t.fromTrackId}`}
                    className="block rounded-card border border-warn/40 bg-warn/5 px-4 py-3"
                  >
                    {g.trackById.get(t.fromTrackId)?.name} → {g.trackById.get(t.toTrackId)?.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="mt-8 rounded-card border border-border bg-surface p-4 text-[13px] text-fg-muted leading-relaxed">
          rekordbox でキューを触ったら、手元で
          <code className="mx-1 whitespace-nowrap rounded bg-elevated px-1.5 py-0.5 font-mono text-[12px]">
            python tools/sync.py
          </code>
          を流すと、差分を1件ずつ確認しながら Notion に反映できます。
          <span className="block mt-1 text-fg-subtle">
            記号（A〜P）は rekordbox 実機の値だけを表示しています。Notion のメモ由来の記号は使っていません。
          </span>
        </p>
      </main>
    </>
  );
}
