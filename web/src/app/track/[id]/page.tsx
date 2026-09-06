import Link from "next/link";
import { notFound } from "next/navigation";
import { CuePad, LoopTag } from "@/components/CuePad";
import { PracticeToggle } from "@/components/PracticeToggle";
import { RatingPicker } from "@/components/RatingPicker";
import { TransitionCard } from "@/components/TransitionCard";
import { cueLabel } from "@/lib/format";
import { bpmDelta, formatPosition, getGraph, type Graph, type Transition } from "@/lib/graph";
import { longestRouteFrom } from "@/lib/route";

/** パンくず。リロードしても DJ 中の文脈が消えないよう URL に持たせる。 */
const parsePath = (raw: unknown): string[] =>
  (typeof raw === "string" ? raw : "").split(",").filter(Boolean);

const hrefWith = (trackId: string, path: string[]) => {
  const trimmed = path.slice(-6);
  return `/track/${trackId}${trimmed.length ? `?path=${trimmed.join(",")}` : ""}`;
};

/** カード1枚に渡す素材をグラフから引き出す。 */
function cardProps(g: Graph, t: Transition) {
  return {
    fromCue: g.cueById.get(t.fromCueId),
    toCue: g.cueById.get(t.toCueId),
    fromTrackCues: g.cuesByTrack.get(t.fromTrackId) ?? [],
    toTrackCues: g.cuesByTrack.get(t.toTrackId) ?? [],
    fromDuration: g.trackById.get(t.fromTrackId)?.durationSec ?? null,
    toDuration: g.trackById.get(t.toTrackId)?.durationSec ?? null,
  };
}

export default async function TrackPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const g = await getGraph();
  const track = g.trackById.get(id);
  if (!track) notFound();

  const path = parsePath(sp.path);
  const crumbs = path.map((p) => g.trackById.get(p)).filter((t) => t !== undefined);

  /** テンポが近い順。ピッチ調整が要らないものから見たい。 */
  const out = [...(g.outgoing.get(id) ?? [])].sort(
    (a, b) =>
      Math.abs(bpmDelta(track.bpm, g.trackById.get(a.toTrackId)?.bpm ?? null) ?? 999) -
      Math.abs(bpmDelta(track.bpm, g.trackById.get(b.toTrackId)?.bpm ?? null) ?? 999),
  );
  const incoming = g.incoming.get(id) ?? [];
  const route = longestRouteFrom(g, id);
  const cues = g.cuesByTrack.get(id) ?? [];

  return (
    <main className="relative z-1 mx-auto max-w-6xl px-4 pb-nav lg:px-8">
      <header className="sticky top-0 z-20 -mx-4 border-b border-border bg-bg/85 px-4 pb-3 pt-3 backdrop-blur-md lg:-mx-8 lg:px-8">
        <nav className="mb-1.5 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-[12px] text-fg-subtle">
          <Link href="/" className="shrink-0 hover:text-fg-muted">一覧</Link>
          {crumbs.map((t, i) => (
            <span key={`${t.id}-${i}`} className="shrink-0">
              <span className="mx-1">/</span>
              <Link href={hrefWith(t.id, path.slice(0, i))} className="hover:text-fg-muted">{t.name}</Link>
            </span>
          ))}
        </nav>
        <div className="flex items-end gap-3">
          <h1 className="text-[26px] font-bold leading-tight tracking-tight break-words lg:text-[30px]">
            {track.name}
          </h1>
          <span className="ml-auto shrink-0 font-mono text-[13px] tabular-nums text-fg-muted">
            {track.bpm ?? "–"}<span className="text-fg-subtle"> BPM</span>
            {track.musicalKey && <> · {track.musicalKey}</>}
            {track.durationSec && (
              <span className="hidden sm:inline text-fg-subtle">
                {" "}· {Math.floor(track.durationSec / 60)}:{String(track.durationSec % 60).padStart(2, "0")}
              </span>
            )}
          </span>
        </div>
      </header>

      <div className="mt-5 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-8">
        {/* 主役: 次に行ける曲 */}
        <section>
          <div className="mb-2.5 flex items-baseline justify-between">
            <h2 className="label">次に行ける曲{out.length > 0 && ` · ${out.length}`}</h2>
            <span className="flex items-center gap-3">
              {/* プレイ中はここから /play へ入る。曲ページは情報が多すぎて片手では読めない */}
              {out.length > 0 && (
                <Link href={`/play?from=${id}`} className="text-[12px] text-accent hover:underline">
                  この曲からプレイ →
                </Link>
              )}
              {route.trackIds.length > 1 && (
                <Link href={`/graph?mode=tree&root=${id}`} className="text-[12px] text-hot hover:underline">
                  ツリー: 最大 {route.trackIds.length} 曲 →
                </Link>
              )}
            </span>
          </div>
          {out.length === 0 ? (
            <div className="rounded-card border border-dashed border-border p-8 text-center">
              <p className="text-fg-subtle">この曲からの繋ぎはまだ記録されていません</p>
              <Link
                data-edit
                href={`/new?from=${id}`}
                className="tap mt-4 inline-flex items-center rounded-card border border-hot/60 bg-hot/15 px-5 text-[14px] font-semibold text-hot transition-colors hover:border-hot"
              >
                この曲から繋ぎを追加 →
              </Link>
            </div>
          ) : (
            <ul className="space-y-3">
              {out.map((t, i) => (
                <li key={t.id}>
                  <TransitionCard
                    transition={t} direction="out" index={i}
                    otherTrack={g.trackById.get(t.toTrackId)}
                    currentBpm={track.bpm}
                    href={hrefWith(t.toTrackId, [...path, id])}
                    maxOnward={longestRouteFrom(g, t.toTrackId).trackIds.length}
                    {...cardProps(g, t)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 脇役: この曲の情報 */}
        <aside className="mt-8 space-y-6 lg:mt-0">
          {cues.length > 0 && (
            <section>
              <h2 className="label mb-2">この曲のキュー · {cues.length}</h2>
              <ul className="rounded-card border border-border bg-surface divide-y divide-border">
                {cues.map((c) => (
                  <li key={c.id} className="flex items-center gap-2.5 px-3 py-2">
                    <CuePad cue={c} size="sm" />
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13.5px]">
                      <span className="min-w-0 truncate">
                        {c.name || <span className="text-fg-subtle">（名前なし）</span>}
                      </span>
                      <LoopTag cue={c} />
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                      {formatPosition(c.positionMs)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {incoming.length > 0 && (
            <section>
              <h2 className="label mb-2">ここに入ってこれる曲 · {incoming.length}</h2>
              <ul className="space-y-2">
                {incoming.map((t) => {
                  const from = g.trackById.get(t.fromTrackId);
                  return (
                    <li key={t.id} className="rounded-card border border-border bg-surface">
                      <Link
                        href={hrefWith(t.fromTrackId, path)}
                        className="flex items-center gap-2.5 rounded-t-card px-3 py-2.5 transition-colors hover:bg-surface-2"
                      >
                        <span className="text-fg-subtle text-[12px] shrink-0">◂</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[14px] break-words">{from?.name ?? "?"}</span>
                          <span className="block truncate text-[12px] text-fg-subtle">
                            {cueLabel(g.cueById.get(t.fromCueId))} → {cueLabel(g.cueById.get(t.toCueId))}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                          {from?.bpm ?? "–"}
                        </span>
                      </Link>
                      {/* 入ってくる側の繋ぎも、ここで星を付け替え・キューを直せる */}
                      <div data-edit className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-1">
                        <RatingPicker id={t.id} value={t.rating} size="sm" className="ml-auto" />
                        <PracticeToggle id={t.id} value={t.practice} />
                        <Link
                          href={`/new?edit=${t.id}`}
                          className="tap inline-flex items-center shrink-0 rounded-full border border-border px-3 text-[12px] text-fg-subtle transition-colors hover:border-border-bright hover:text-fg"
                        >
                          編集
                        </Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <div className="space-y-4">
            <Link
              href={`/graph?from=${id}`}
              className="block rounded-card border border-accent/30 bg-accent/5 p-4 text-[13.5px] text-accent transition-colors hover:border-accent/60"
            >
              グラフでこの曲の周辺を見る →
            </Link>
            {/*
              曲を見ている最中に思い出した繋ぎを、その場から入れられるようにする。
              入力画面はこの曲が入った状態で開くので、次に押すのはキューのパッド。
              向きは2つとも要る（この画面は「行ける先」と「入ってこれる元」を両方出しているため）
            */}
            <section data-edit>
              <h2 className="label mb-2">繋ぎを追加</h2>
              {/* 繋ぎが0本のときは上の空状態が「この曲から」の入口。同じ行き先を2つ出さない */}
              <div className={`grid gap-2 ${out.length === 0 ? "grid-cols-1" : "grid-cols-2"}`}>
                {out.length > 0 && (
                  <Link
                    href={`/new?from=${id}`}
                    className="tap flex items-center justify-center rounded-card border border-border bg-surface text-center text-[13px] text-fg-muted transition-colors hover:border-border-bright hover:text-fg"
                  >
                    この曲から →
                  </Link>
                )}
                <Link
                  href={`/new?to=${id}`}
                  className="tap flex items-center justify-center rounded-card border border-border bg-surface text-center text-[13px] text-fg-muted transition-colors hover:border-border-bright hover:text-fg"
                >
                  ← この曲へ
                </Link>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </main>
  );
}
