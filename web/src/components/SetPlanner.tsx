"use client";

import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { minutesLabel, setLength, timingOf } from "@/lib/duration";
import { filterSummary, isFiltering, passesFilter, skipsTrack } from "@/lib/playFilter";
import { insertUnplaced } from "@/lib/planInsert";
import { usePlanMode } from "@/lib/planMode";
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
 * - 「差し込む」にすると、繋ぎが無い・同じ道に入り切らない曲を、BPM・キーが近い所へ**記録なしの間**として
 *   入れる（`lib/planInsert.ts`。除外条件で外れた曲・別リミックスが入っている曲は入れない）。
 *   /play へ渡す予定と、プレイリスト保存は**記録のある繋ぎだけ**で作る
 *
 * 選んだ曲は端末に残す（`lib/playlog.ts`。差し込むかどうかは `lib/planMode.ts`）。Notion には何も書かないので `data-edit` は付けない。
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
  const [mode, setMode] = usePlanMode();

  /** 入らなかった曲と、その理由（`insertable` = 差し込みの対象になる理由か） */
  const unplaced = useMemo(() => {
    const inRoute = new Set(plan.trackIds);
    const routeSongs = new Set(plan.trackIds.map(songOf));
    const linked = (id: string, list: readonly Transition[]) =>
      list.some((t) => t.fromTrackId === id || t.toTrackId === id);
    const usableList = [...usable.values()].flat();
    return deferred
      .filter((id) => !inRoute.has(id))
      .map((id) => {
        const track = trackById.get(id);
        const [reason, insertable] = routeSongs.has(songOf(id))
          ? ["同じ曲の別リミックスが道筋に入っています", false]
          : track && skipsTrack(filter, track)
            ? ["この曲のジャンル・タグが除外条件に入っています", false]
            : !linked(id, transitions)
              ? ["この曲の繋ぎがまだ記録されていません", true]
              : !linked(id, usableList)
                ? ["この曲の繋ぎが、どれも除外条件で外れています", false]
                : ["繋ぎはありますが、同じ道筋に入れられませんでした", true];
        return { id, name: track?.name ?? "不明な曲", reason, insertable };
      });
  }, [plan, deferred, usable, transitions, songOf, trackById, filter]);

  /** 「差し込む」なら、BPM・キーが近い所へ記録なしの間として入れた道筋。「省く」なら道筋そのまま */
  const shownRoute = useMemo(() => {
    if (mode !== "insert") return { trackIds: plan.trackIds, hops: plan.edges as (Transition | null)[], inserted: [] as string[] };
    return insertUnplaced(plan.trackIds, plan.edges, unplaced.filter((m) => m.insertable).map((m) => m.id), trackById);
  }, [mode, plan, unplaced, trackById]);
  const insertedSet = useMemo(() => new Set(shownRoute.inserted), [shownRoute]);
  const missing = useMemo(() => unplaced.filter((m) => !insertedSet.has(m.id)), [unplaced, insertedSet]);
  // 記録なしの間は null。`setLength` は空の間を「頭から / 終わりまで」として数えるので、そのまま渡せる
  const length = useMemo(
    () => setLength(shownRoute.trackIds, shownRoute.hops as Transition[], lookup),
    [shownRoute, lookup],
  );
  /** /play の「予定」の印は繋ぎIDで付くので、記録のある繋ぎだけを渡す（途中に差し込んで切った繋ぎは入らない） */
  const recordedHops = useMemo(() => shownRoute.hops.filter((h): h is Transition => !!h), [shownRoute]);

  /** 繋ぎが1本でもある曲（向きは問わない）。無い曲は一覧で「未接続」と出し、後ろへ回す */
  const connected = useMemo(() => {
    const s = new Set<string>();
    for (const t of transitions) { s.add(t.fromTrackId); s.add(t.toTrackId); }
    return s;
  }, [transitions]);
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const words = q.normalize("NFKC").trim().toLowerCase().split(/\s+/).filter(Boolean);
    return tracks
      .filter((t) => {
        const hay = `${t.name} ${t.alias} ${t.fullTitle}`.normalize("NFKC").toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) =>
        Number(connected.has(b.id)) - Number(connected.has(a.id)) || a.name.localeCompare(b.name, "ja"));
  }, [q, tracks, connected]);

  const start = () => setStored({ wanted, route: recordedHops.map((e) => e.id) });
  const total = shownRoute.trackIds.length;

  return (
    <main className="relative z-1 mx-auto max-w-2xl px-4 pb-nav pt-4">
      <div className="pr-corner flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-[22px] font-bold tracking-tight">セットを組む</h1>
        <Link
          href="/play"
          className="btn"
        >
          ← プレイ
        </Link>
      </div>
      <p
        className="mt-1 text-[13px] text-fg-muted"
        title="道筋は選んだ曲で始まり、選んだ曲で終わります。通る数が同じなら、長くつなげる方を出します"
      >
        選んだ曲をなるべく多く通る道筋を、間に他の曲も挟んで出します。
      </p>
      {filtering && (
        <p className="mt-2 text-[12.5px] text-warn">
          除外条件（{filterSummary(filter)}）で外した繋ぎは通りません。条件は「プレイ」の画面で変えられます。
        </p>
      )}

      {/* ── 繋げられない曲の扱い ── */}
      <div className="mt-3" role="radiogroup" aria-label="繋げられない曲の扱い">
        <span className="label">繋げられない曲</span>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          {([
            ["skip", "省く", "道筋に入らなかった曲は、理由を付けて下に出します"],
            ["insert", "BPM・キーが近い所に差し込む", "繋ぎが無い・同じ道に入り切らない曲を、記録なしの間として道筋の頭・尻（または途中）へ入れます"],
          ] as const).map(([value, label, title]) => (
            <button
              key={value}
              role="radio"
              aria-checked={mode === value}
              title={title}
              onClick={() => setMode(value)}
              className={`btn rounded-card px-2 text-[12.5px] ${mode === value ? "btn-accent" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── 結果 ── */}
      {wanted.length > 0 && (
        <section className={`mt-4 rounded-card border border-border bg-surface p-3 ${stale ? "opacity-60" : ""}`}>
          <p className="text-[14px] font-semibold">
            選んだ{deferred.length}曲中 <span className="text-hot">{plan.hits + shownRoute.inserted.length}曲</span>を通る
            {shownRoute.inserted.length > 0 && ` · うち差し込み ${shownRoute.inserted.length}`}
            {plan.trackIds.length > plan.hits && ` · 挟む曲 ${plan.trackIds.length - plan.hits}`}
            {` · 全${total}曲`}
            {total > 1 && (
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
              trackIds={shownRoute.trackIds}
              edges={shownRoute.hops}
              trackById={trackById}
              cueById={cueById}
              marked={wantedSet}
              inserted={insertedSet}
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
          {shownRoute.inserted.length > 0 && !stale && (
            <p className="mt-2 text-[12px] text-fg-subtle">
              記録なしの間は、/play では「曲を変える」で次の曲へ移ります。
            </p>
          )}
          {total > 0 && !stale && (
            <Link
              href={`/play?from=${encodeURIComponent(shownRoute.trackIds[0])}`}
              onClick={start}
              className="btn btn-hot mt-3 w-full rounded-card text-[14px]"
            >
              この順で /play を始める →
            </Link>
          )}
          {/*
            画面に出している道筋（差し込んだ曲も含む）をそのまま保存する。差し込んだ間は記録に無いので
            null = プレイリストでは繋ぎ無しになる
          */}
          {shownRoute.trackIds.length > 1 && !stale && (
            <SaveAsPlaylist
              key={shownRoute.trackIds.join(",")}
              trackIds={shownRoute.trackIds}
              edges={shownRoute.hops}
              trackById={trackById}
              defaultName={`${trackById.get(shownRoute.trackIds[0])?.name ?? ""} 始まり`}
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
            className="btn text-[12px]"
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
              className="btn btn-accent justify-start rounded-card px-2.5 py-1 text-left text-[13px]"
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
                {!connected.has(t.id) && <span className="shrink-0 text-[12px] text-fg-subtle">未接続</span>}
                <span className="shrink-0 font-mono text-[13px] tabular-nums text-fg-subtle">{t.bpm ?? "–"}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
