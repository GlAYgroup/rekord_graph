"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * 「セットを組む」で、**繋ぎが無くて道筋に入らなかった曲をどう扱うか**（端末だけが持つ）。
 *  - `skip`   … 省く（入らなかった曲として理由つきで出す）
 *  - `insert` … BPM・キーが近い所へ「記録なし」の間として差し込む（`lib/planInsert.ts`）
 *
 * `lib/playlog.ts` の `PlayPlan`（`rg.play.plan.v1`）とは別の鍵に置く。
 * 作りは `useStoredPlan` と同じ: サーバで描く間は既定値、別のタブの変更は `storage` で追いつく。
 */
export type PlanMode = "skip" | "insert";

const KEY = "rg.play.plan.mode.v1";
const DEFAULT: PlanMode = "skip";
const listeners = new Set<() => void>();

function snapshot(): PlanMode {
  try {
    return localStorage.getItem(KEY) === "insert" ? "insert" : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => { listeners.delete(onChange); window.removeEventListener("storage", onChange); };
}

export function usePlanMode(): [PlanMode, (m: PlanMode) => void] {
  const mode = useSyncExternalStore(subscribe, snapshot, () => DEFAULT);
  const set = useCallback((m: PlanMode) => {
    try { localStorage.setItem(KEY, m); } catch { /* 残せなくてもこの画面の中では効く */ }
    for (const l of listeners) l();
  }, []);
  return [mode, set];
}
