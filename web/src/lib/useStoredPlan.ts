"use client";

import { useCallback, useSyncExternalStore } from "react";
import { PLAN, readPlan, writePlan, type PlayPlan } from "./playlog";

/**
 * 端末に残した「セットを組む」の中身（`lib/playlog.ts` の `PlayPlan`）を読み書きする。
 * 作りは `useStoredFilter` と同じ: サーバで描く間は空、別のタブの変更は `storage` イベントで追いつく。
 */
const EMPTY: PlayPlan = { wanted: [], route: [] };
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: PlayPlan = EMPTY;

function snapshot(): PlayPlan {
  let raw: string | null = null;
  try { raw = localStorage.getItem(PLAN); } catch { /* 読めなければ空 */ }
  // 同じ中身なら同じオブジェクトを返す（毎回作ると描き直しが止まらない）
  if (raw !== cachedRaw) { cachedRaw = raw; cached = readPlan(); }
  return cached;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => { listeners.delete(onChange); window.removeEventListener("storage", onChange); };
}

export function useStoredPlan(): [PlayPlan, (p: PlayPlan) => void] {
  const plan = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const set = useCallback((p: PlayPlan) => {
    writePlan(p);
    for (const l of listeners) l();
  }, []);
  return [plan, set];
}
