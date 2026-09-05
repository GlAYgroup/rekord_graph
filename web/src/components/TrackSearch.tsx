"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

export type SearchTrack = {
  id: string;
  name: string;
  fullTitle: string;
  alias: string;
  bpm: number | null;
  musicalKey: string;
  out: number;
  in: number;
  /** この曲を起点に最大何曲つなげるか（この曲を含む）。グラフ・曲ページと同じ数え方 */
  maxFrom: number;
  /** キュー位置（曲全体に対する %）。カードのミニストリップに使う */
  ticks: number[];
};

/** 正準名・別名・フルタイトルのどれでも引っかかるようにする（「脳漿」で探せること）。 */
function matches(t: SearchTrack, q: string): boolean {
  const hay = `${t.name} ${t.alias} ${t.fullTitle}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

type SortKey = "name" | "bpm" | "links";

export function TrackSearch({ tracks }: { tracks: SearchTrack[] }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("name");

  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = query ? tracks.filter((t) => matches(t, query)) : [...tracks];
    if (sort === "bpm") list.sort((a, b) => (a.bpm ?? 999) - (b.bpm ?? 999));
    if (sort === "links") list.sort((a, b) => b.out + b.in - (a.out + a.in));
    return list;
  }, [q, sort, tracks]);

  return (
    <>
      <div className="sticky top-0 z-20 -mx-4 border-b border-border bg-bg/85 px-4 pb-3 pt-4 backdrop-blur-md lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <h1 className="text-[24px] font-bold leading-none tracking-tight">rekord_graph</h1>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="曲を検索（別名でも可）"
            inputMode="search"
            autoComplete="off"
            className="h-11 w-full rounded-card border border-border bg-surface px-4 text-[16px] outline-none placeholder:text-fg-subtle focus:border-accent sm:ml-auto sm:w-72"
          />
          <div className="flex items-center gap-1 text-[12px]" role="group" aria-label="並び替え">
            {([["name", "名前"], ["bpm", "BPM"], ["links", "繋ぎの多さ"]] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setSort(k)}
                className={`rounded-full border px-3 py-1.5 transition-colors ${
                  sort === k
                    ? "border-accent/50 bg-accent/10 text-accent"
                    : "border-border text-fg-subtle hover:text-fg-muted"
                }`}
              >
                {label}
              </button>
            ))}
            <span className="ml-2 font-mono text-fg-subtle tabular-nums">{shown.length}曲</span>
          </div>
        </div>
      </div>

      <ul className="mt-4 grid gap-2.5 pb-nav sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((t, i) => (
          <li key={t.id}>
            <Link
              href={`/track/${t.id}`}
              className="group block rounded-card border border-border bg-linear-to-b from-surface to-surface-2 p-3.5 transition-colors hover:border-border-bright active:border-accent/50 rise"
              style={{ animationDelay: `${Math.min(i, 12) * 25}ms`, boxShadow: "var(--shadow-card)" }}
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 font-semibold text-[15.5px] break-words">{t.name}</span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                  {t.bpm ?? "–"}{t.musicalKey && ` ${t.musicalKey}`}
                </span>
              </div>
              {/* キュー位置のミニストリップ。カードに曲ごとの「顔」を持たせる */}
              <div className="relative mt-2.5 h-[7px] overflow-hidden rounded-full bg-bg-deep">
                {t.ticks.map((x, j) => (
                  <span
                    key={j}
                    className="absolute inset-y-0 w-[2px] rounded-full bg-hot/70"
                    style={{ left: `${x}%` }}
                  />
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2 font-mono text-[11px] tabular-nums">
                {t.out + t.in === 0 ? (
                  <span className="text-fg-subtle">未接続</span>
                ) : (
                  <>
                    <span className={t.out > 0 ? "text-accent" : "text-fg-subtle"}>→ {t.out}</span>
                    <span className={t.in > 0 ? "text-fg-muted" : "text-fg-subtle"}>{t.in} →</span>
                  </>
                )}
                {/*
                  この曲から先へどこまで伸ばせるか。グラフのパネルと同じ「最大N曲」。
                  未接続の曲に「行き止まり」は自明なので出さない（同じことを2回言わない）
                */}
                {t.out + t.in > 0 && (
                  <span
                    className={`ml-auto ${t.maxFrom > 1 ? "text-hot" : "text-fg-subtle"}`}
                    title="この曲を起点に、同じ曲を2回かけずに最大何曲つなげられるか（この曲を含む）"
                  >
                    {t.maxFrom > 1 ? `最大${t.maxFrom}曲` : "行き止まり"}
                  </span>
                )}
              </div>
            </Link>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="col-span-full py-10 text-center text-fg-subtle">見つかりませんでした</li>
        )}
      </ul>
    </>
  );
}
