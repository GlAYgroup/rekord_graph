"use client";

import { useCallback, useSyncExternalStore } from "react";
import { PLAYLIST_POS, readPlaylistPositions, writePlaylistPosition } from "./playlog";

/**
 * プレイリストのプレイ画面で「今何曲目か」（0始まり）。端末が持つ（`lib/playlog.ts`）。
 * 作りは `useStoredFilter` と同じ（サーバで描く間は 0、別のタブの変更は `storage` イベントで追いつく）。
 */
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: Record<string, number> = {};

function snapshot(): Record<string, number> {
  let raw: string | null = null;
  try { raw = localStorage.getItem(PLAYLIST_POS); } catch { /* 読めなければ最初から */ }
  if (raw !== cachedRaw) { cachedRaw = raw; cached = readPlaylistPositions(); }
  return cached;
}

const EMPTY: Record<string, number> = {};

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => { listeners.delete(onChange); window.removeEventListener("storage", onChange); };
}

export function usePlaylistPos(id: string): [number, (pos: number) => void] {
  const all = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const set = useCallback((pos: number) => {
    writePlaylistPosition(id, pos);
    for (const l of listeners) l();
  }, [id]);
  return [all[id] ?? 0, set];
}
