"use client";

import { useCallback, useSyncExternalStore } from "react";
import { FILTER, NO_FILTER, readFilter, writeFilter, type PlayFilter } from "./playlog";

/**
 * 端末に残した除外条件（`/play` と同じもの）を読み書きする。グラフで使う（`/play` と同じ条件が効く）。
 * localStorage はサーバに無いので、サーバで描く間は「条件なし」。
 * 別のタブで `/play` の条件を変えても `storage` イベントで追いつく。
 */
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: PlayFilter = NO_FILTER;

function snapshot(): PlayFilter {
  let raw: string | null = null;
  try { raw = localStorage.getItem(FILTER); } catch { /* 読めなければ条件なし */ }
  // 同じ中身なら同じオブジェクトを返す（毎回作ると描き直しが止まらない）
  if (raw !== cachedRaw) { cachedRaw = raw; cached = readFilter(); }
  return cached;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => { listeners.delete(onChange); window.removeEventListener("storage", onChange); };
}

export function useStoredFilter(): [PlayFilter, (f: PlayFilter) => void] {
  const filter = useSyncExternalStore(subscribe, snapshot, () => NO_FILTER);
  const set = useCallback((f: PlayFilter) => {
    writeFilter(f);
    for (const l of listeners) l();
  }, []);
  return [filter, set];
}
