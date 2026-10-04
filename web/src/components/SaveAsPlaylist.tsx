"use client";

import Link from "next/link";
import { useState } from "react";
import type { Track, Transition } from "@/lib/types";

/**
 * 道筋（「セットを組む」の結果・/play の「最大◯曲」を開いたもの）を、そのままイベントの
 * プレイリスト（🎶Playlists）として保存する口。押すと名前と日付の欄が開き、保存すると
 * 開くリンクに変わる。曲は rekordbox の ContentID、間は道筋の繋ぎIDで持つ（`lib/playlist.ts`）。
 * Notion に書くので `data-edit`（本番中は畳む）。
 */
export function SaveAsPlaylist({
  trackIds, edges, trackById, defaultName,
}: {
  trackIds: readonly string[];
  /**
   * `edges[i]` が `trackIds[i]` → `trackIds[i+1]`。**null = 記録に無い間**（「曲を変える」で移った手・
   * セットを組むで差し込んだ曲）。プレイリストでは繋ぎ無し（`-`）として残る
   */
  edges: readonly (Transition | null)[];
  trackById: ReadonlyMap<string, Track>;
  defaultName: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rbIds = trackIds.map((id) => trackById.get(id)?.rekordboxId ?? "");

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, date: date || null, memo: "", trackRbIds: rbIds, hops: edges.map((e) => e?.id ?? null) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `保存できませんでした（${res.status}）`);
      setSavedId(json.playlist.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (savedId) {
    return (
      <Link
        href={`/playlists/${savedId}`}
        className="btn btn-accent mt-2 w-full rounded-card text-[13.5px]"
      >
        保存しました · プレイリストを開く →
      </Link>
    );
  }
  if (!open) {
    return (
      <button
        data-edit
        onClick={() => setOpen(true)}
        disabled={rbIds.some((id) => !id)}
        className="btn btn-accent mt-2 w-full rounded-card text-[13.5px]"
      >
        この道筋をプレイリストとして保存
      </button>
    );
  }
  return (
    <div data-edit className="mt-2 rounded-card border border-accent/40 p-2.5">
      <div className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="イベント名"
          className="h-10 min-w-0 flex-1 basis-40 rounded-card border border-border bg-bg px-3 text-[14px] outline-none focus:border-accent"
        />
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-10 rounded-card border border-border bg-bg px-2 text-[13px] outline-none focus:border-accent"
        />
      </div>
      <div className="mt-2 flex gap-2">
        <button
          onClick={save}
          disabled={busy || !name.trim()}
          className="btn btn-accent flex-1 rounded-card text-[13.5px] font-semibold"
        >
          {busy ? "保存中…" : `${trackIds.length}曲を保存`}
        </button>
        <button onClick={() => setOpen(false)} className="btn rounded-card px-3 text-[13px]">
          やめる
        </button>
      </div>
      {error && <p className="mt-1.5 text-[12.5px] text-warn">{error}</p>}
    </div>
  );
}
