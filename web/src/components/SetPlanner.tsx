"use client";

import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { minutesLabel, setLength, timingOf } from "@/lib/duration";
import { filterSummary, isFiltering, passesFilter } from "@/lib/playFilter";
import { readPlan } from "@/lib/playlog";
import { planRoute } from "@/lib/route";
import type { Cue, Track, Transition } from "@/lib/types";
import { useStoredFilter } from "@/lib/useStoredFilter";
import { useStoredPlan } from "@/lib/useStoredPlan";
import { RouteSteps } from "./RouteSteps";
import { SaveAsPlaylist } from "./SaveAsPlaylist";

/**
 * セットを組む（`/play/plan`）。**入れたい曲を選ぶと、それをなるべく多く通る道筋を出す。**
 *
 * - 良さは「入れたい曲を何曲通るか → 同数なら全体の曲数が多い方」。間に他の曲を挟んでよいが、
 *   道筋は入れたい曲で始まり、入れたい曲で終わる（探索は `lib/route.ts` の `planRoute`）
 * - `/play` と同じ約束で辿る: 同じ曲（リミックス違い含む）は2回かけない・除外条件で外した繋ぎは
 *   通らない・入った位置より前から抜ける繋ぎは通らない
 * - 入らなかった曲には**理由を付けて**出す（データが無いのか、条件で外れたのか、道に入り切らないのか
 *   を見分けられないと、壊れているのと区別が付かない）
 * - 「この順で始める」で `/play?from=<最初の曲>` を開く。道筋は端末に残り、`/play` は
 *   予定の繋ぎに印を付ける（並びは変えない）
 *
 * 選んだ曲は端末に残す（`lib/playlog.ts`）。Notion には何も書かないので `data-edit` は付けない。
 */
export function SetPlanner({
  tracks, cues, transitions,
}: {
  tracks: Track[];
  cues: Cue[];
  transitions: Transition[];
}) {
  const trackById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);
  const songOf = useMemo(() => (id: string) => trackById.get(id)?.songId ?? id, [trackById]);
  const lookup = useMemo(() => ({
    durationSec: (id: string) => trackById.get(id)?.durationSec ?? null,
    bpm: (id: string) => trackById.get(id)?.bpm ?? null,
    cueMs: (id: string) => cueById.get(id)?.positionMs ?? null,
  }), [trackById, cueById]);
  const timing = useMemo(() => (t: Transition) => timingOf(t, lookup), [lookup]);

  const [filter] = useStoredFilter();
  const filtering = isFiltering(filter);
  const usable = useMemo(() => {
    const m = new Map<string, Transition[]>();
    for (const t of transitions) {
      if (!passesFilter(filter, t, trackById.get(t.toTrackId))) continue;
      (m.get(t.fromTrackId) ?? m.set(t.fromTrackId, []).get(t.fromTrackId)!).push(t);
    }
    return m;
  }, [transitions, filter, trackById]);

  /** 選んだ曲は端末が持つ（サーバで描く間は空）。消えた曲は数えない */
  const [stored, setStored] = useStoredPlan();
  const wanted = useMemo(() => stored.wanted.filter((id) => trackById.has(id)), [stored.wanted, trackById]);
  const wantedSet = useMemo(() => new Set(wanted), [wanted]);
  /** 描き直しの前に続けて押されても取りこぼさないよう、書く直前の保存値から作る */
  const setWanted = (next: (cur: string[]) => string[]) => {
    const cur = readPlan();
    setStored({ ...cur, wanted: next(cur.wanted) });
  };
  const toggle = (id: string) =>
    setWanted((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  // 探索は重いことがあるので、選ぶ手を止めない（結果は少し遅れて追いつく）
  const deferred = useDeferredValue(wanted);
  const plan = useMemo(
    () => planRoute(usable, songOf, new Set(deferred), timing),
    [usable, songOf, deferred, timing],
  );
  const stale = deferred !== wanted;
  const length = useMemo(() => setLength(plan.trackIds, plan.edges, lookup), [plan, lookup]);

  /** 入らなかった曲と、その理由 */
  const missing = useMemo(() => {
    const inRoute = new Set(plan.trackIds);
    const routeSongs = new Set(plan.trackIds.map(songOf));
    const linked = (id: string, list: readonly Transition[]) =>
      list.some((t) => t.fromTrackId === id || t.toTrackId === id);
    const usableList = [...usable.values()].flat();
    return deferred
      .filter((id) => !inRoute.has(id))
      .map((id) => {
        const reason = routeSongs.has(songOf(id))
          ? "同じ曲の別リミックスが道筋に入っています"
          : !linked(id, transitions)
            ? "この曲の繋ぎがまだ記録されていません"
            : !linked(id, usableList)
              ? "この曲の繋ぎが、どれも除外条件で外れています"
              : "繋ぎはありますが、同じ道筋に入れられませんでした";
        return { id, name: trackById.get(id)?.name ?? "不明な曲", reason };
      });
  }, [plan, deferred, usable, transitions, songOf, trackById]);

  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const words = q.normalize("NFKC").trim().toLowerCase().split(/\s+/).filter(Boolean);
    return tracks
      .filter((t) => {
        const hay = `${t.name} ${t.alias} ${t.fullTitle}`.normalize("NFKC").toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }, [q, tracks]);

  const start = () => setStored({ wanted, route: plan.edges.map((e) => e.id) });

  return (
    <main className="relative z-1 mx-auto max-w-2xl px-4 pb-nav pt-4">
      <div className="flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-[22px] font-bold tracking-tight">セットを組む</h1>
        <Link
          href="/play"
          className="tap shrink-0 rounded-full border border-border bg-surface px-3 text-[12.5px] text-fg-subtle hover:text-fg"
        >
          ← プレイ
        </Link>
      </div>
      <p className="mt-1 text-[13px] text-fg-muted">
        入れたい曲を選ぶと、それをなるべく多く通る道筋を出します。間に他の曲を挟むことがあります。
        道筋は選んだ曲で始まり、選んだ曲で終わります。選んだ曲の数が同じなら、長くつなげる方を出します。
      </p>
      {filtering && (
        <p className="mt-2 text-[12.5px] text-warn">
          除外条件（{filterSummary(filter)}）で外した繋ぎは通りません。条件は「プレイ」の画面で変えられます。
        </p>
      )}

      {/* ── 結果 ── */}
      {wanted.length > 0 && (
        <section className={`mt-4 rounded-card border border-border bg-surface p-3 ${stale ? "opacity-60" : ""}`}>
          <p className="text-[14px] font-semibold">
            選んだ{deferred.length}曲中 <span className="text-hot">{plan.hits}曲</span>を通る
            {plan.trackIds.length > plan.hits && ` · 挟む曲 ${plan.trackIds.length - plan.hits}`}
            {` · 全${plan.trackIds.length}曲`}
            {plan.trackIds.length > 1 && (
              <span className="font-normal text-fg-muted">
                {` · ${length.approx ? "目安 " : ""}${minutesLabel(length.cutSec)}（全長 ${minutesLabel(length.fullSec)}）`}
              </span>
            )}
          </p>
          {plan.truncated && (
            <p className="mt-1 text-[12px] text-fg-subtle">
              組み合わせが多く、途中で探すのを打ち切りました。少なくともこの曲数は通れます。
            </p>
          )}
          <div className="mt-3">
            <RouteSteps
              trackIds={plan.trackIds}
              edges={plan.edges}
              trackById={trackById}
              cueById={cueById}
              marked={wantedSet}
            />
          </div>
          {missing.length > 0 && (
            <div className="mt-3 border-t border-border pt-2">
              <span className="label">入らなかった曲</span>
              <ul className="mt-1 space-y-1">
                {missing.map((m) => (
                  <li key={m.id} className="text-[13px]">
                    <span className="text-fg">{m.name}</span>
                    <span className="text-fg-subtle"> — {m.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.trackIds.length > 0 && !stale && (
            <Link
              href={`/play?from=${encodeURIComponent(plan.trackIds[0])}`}
              onClick={start}
              className="tap mt-3 flex items-center justify-center rounded-card border border-hot/50 bg-hot/12 text-[14px] font-semibold text-hot"
            >
              この順で /play を始める →
            </Link>
          )}
          {plan.trackIds.length > 1 && !stale && (
            <SaveAsPlaylist
              key={plan.edges.map((e) => e.id).join(",")}
              trackIds={plan.trackIds}
              edges={plan.edges}
              trackById={trackById}
              defaultName={`${trackById.get(plan.trackIds[0])?.name ?? ""} 始まり ${plan.trackIds.length}曲`}
            />
          )}
        </section>
      )}

      {/* ── 選んだ曲 ── */}
      <div className="mt-4 flex items-center gap-2">
        <span className="label flex-1">入れたい曲 {wanted.length}</span>
        {wanted.length > 0 && (
          <button
            onClick={() => setWanted(() => [])}
            className="tap rounded-full border border-border bg-surface px-3 text-[12px] text-fg-subtle hover:text-fg"
          >
            全部外す
          </button>
        )}
      </div>
      {wanted.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {wanted.map((id) => (
            <button
              key={id}
              onClick={() => toggle(id)}
              title="押すと外す"
              className="tap rounded-card border border-accent/50 bg-accent/10 px-2.5 py-1 text-left text-[13px] text-accent"
            >
              {trackById.get(id)?.name ?? "不明な曲"} ×
            </button>
          ))}
        </div>
      )}

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="曲を検索（別名でも可）"
        inputMode="search"
        autoComplete="off"
        className="mt-3 h-12 w-full rounded-card border border-border bg-surface px-4 text-[16px] outline-none placeholder:text-fg-subtle focus:border-accent"
      />
      <ul className="mt-3 space-y-1.5">
        {shown.map((t) => {
          const on = wanted.includes(t.id);
          return (
            <li key={t.id}>
              <button
                onClick={() => toggle(t.id)}
                aria-pressed={on}
                className={`tap flex w-full items-center gap-3 rounded-card border px-3 py-2 text-left transition-colors ${
                  on ? "border-accent/60 bg-accent/10" : "border-border bg-surface hover:border-border-bright"
                }`}
              >
                <span className={`grid size-5 shrink-0 place-items-center rounded border text-[12px] ${on ? "border-accent bg-accent text-bg" : "border-border"}`}>
                  {on ? "✓" : ""}
                </span>
                <span className={`min-w-0 flex-1 break-words text-[14.5px] ${on ? "text-accent" : ""}`}>{t.name}</span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">{t.bpm ?? "–"}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
