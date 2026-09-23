"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { Playlist } from "@/lib/playlist";
import type { Track } from "@/lib/types";

/**
 * イベントごとのプレイリストの一覧（新しい日付が上）と、新しく作る口。
 * 作ると、そのまま中身を並べる画面（`/playlists/<id>`）へ移る。
 * 道筋から作る口は「セットを組む」と /play の「最大◯曲」を開いた所にある（`SaveAsPlaylist`）。
 */
export function PlaylistIndex({ playlists, tracks }: { playlists: Playlist[]; tracks: Track[] }) {
  const router = useRouter();
  const byRb = useMemo(() => new Map(tracks.map((t) => [t.rekordboxId, t])), [tracks]);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, date: date || null, memo: "", trackRbIds: [], hops: [] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `保存できませんでした（${res.status}）`);
      router.push(`/playlists/${json.playlist.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <main className="relative z-1 mx-auto max-w-2xl px-4 pb-nav pt-4">
      <div className="flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-[22px] font-bold tracking-tight">プレイリスト</h1>
        <Link
          href="/play"
          className="tap shrink-0 rounded-full border border-border bg-surface px-3 text-[12.5px] text-fg-subtle hover:text-fg"
        >
          ← プレイ
        </Link>
      </div>
      <p className="mt-1 text-[13px] text-fg-muted">
        イベントごとのセットを残しておく場所です。道筋から作るときは「セットを組む」か、
        /play の曲を選ぶ一覧で「最大◯曲」を開いて「プレイリストとして保存」から。
      </p>

      <section data-edit className="mt-4 rounded-card border border-border bg-surface p-3">
        <span className="label">新しいプレイリスト</span>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="イベント名（例: ◯◯ 9/28）"
            className="h-11 min-w-0 flex-1 basis-48 rounded-card border border-border bg-bg px-3 text-[15px] outline-none focus:border-accent"
          />
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-11 rounded-card border border-border bg-bg px-3 text-[14px] outline-none focus:border-accent"
          />
          <button
            onClick={create}
            disabled={!name.trim() || busy}
            className="tap rounded-card border border-accent/50 bg-accent/10 px-4 text-[14px] font-semibold text-accent disabled:opacity-40"
          >
            {busy ? "作成中…" : "作って曲を並べる"}
          </button>
        </div>
        {error && <p className="mt-2 text-[13px] text-warn">{error}</p>}
      </section>

      <ul className="mt-4 space-y-2">
        {playlists.map((pl) => {
          const first = byRb.get(pl.trackRbIds[0] ?? "");
          const last = byRb.get(pl.trackRbIds[pl.trackRbIds.length - 1] ?? "");
          const gaps = pl.hops.filter((h) => h === null).length;
          return (
            <li key={pl.id}>
              <Link
                href={`/playlists/${pl.id}`}
                className="block rounded-card border border-border bg-surface p-3 transition-colors hover:border-border-bright"
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 break-words text-[16px] font-semibold">{pl.name}</span>
                  {pl.date && <span className="shrink-0 font-mono text-[12px] tabular-nums text-fg-subtle">{pl.date}</span>}
                </div>
                <p className="mt-1 text-[12.5px] text-fg-muted">
                  {pl.trackRbIds.length}曲
                  {first && ` · ${first.name}`}
                  {last && pl.trackRbIds.length > 1 && ` → ${last.name}`}
                  {gaps > 0 && <span className="text-warn">{` · 繋ぎなし ${gaps}か所`}</span>}
                </p>
              </Link>
            </li>
          );
        })}
        {playlists.length === 0 && (
          <li className="px-1 py-3 text-[13px] text-fg-subtle">まだプレイリストはありません。</li>
        )}
      </ul>
    </main>
  );
}
