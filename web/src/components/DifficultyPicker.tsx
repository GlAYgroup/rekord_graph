"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DIFFICULTIES } from "@/lib/difficulty";

/**
 * 難易度（🔀Transitions の「難易度」）をその場で付け替える。`RatingPicker` と同じ作り:
 * 押した瞬間に見た目を変え、失敗したときだけ元に戻す。同じものをもう一度押すと外す。
 */
export function DifficultyPicker({
  id, value, className = "", refresh = true, onSaved,
}: {
  /** 🔀Transitions のページID */
  id: string;
  value: string | null;
  className?: string;
  /** 保存できたら画面を取り直すか。入力画面の一括編集では false（1タップごとに全件取り直さない） */
  refresh?: boolean;
  /** 保存できた値を親へ返す（一括編集が手元の一覧を書き換えるため） */
  onSaved?: (value: string | null) => void;
}) {
  const router = useRouter();
  /** 押した結果。undefined = まだ押していない（= サーバの値をそのまま出す） */
  const [pressed, setPressed] = useState<string | null | undefined>(undefined);
  const [seenValue, setSeenValue] = useState(value);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // サーバから新しい値が来たらそちらに従う（別の画面で変えた分を拾う）
  if (seenValue !== value) { setSeenValue(value); setPressed(undefined); }

  const current = pressed === undefined ? value : pressed;

  const set = async (next: string | null) => {
    const before = current;
    setPressed(next); setBusy(true); setFailed(false);
    try {
      const res = await fetch("/api/transitions/difficulty", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, difficulty: next }),
      });
      if (!res.ok) throw new Error();
      onSaved?.(next);
      if (refresh) router.refresh();
    } catch {
      setPressed(before);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span
      className={`inline-flex items-center gap-1 ${className}`}
      role="group"
      aria-label="難易度"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {DIFFICULTIES.map((d) => {
        const on = current === d;
        return (
          <button
            key={d}
            type="button"
            disabled={busy}
            onClick={() => set(on ? null : d)}
            aria-pressed={on}
            aria-label={`難易度 ${d}${on ? "（もう一度押すと外す）" : ""}`}
            className={`tap inline-flex items-center rounded-full border px-2.5 text-[12px] transition-colors ${
              on
                ? "border-accent/60 bg-accent/12 text-accent"
                : "border-border text-fg-subtle hover:border-border-bright hover:text-fg"
            } ${busy ? "opacity-60" : ""}`}
          >
            {d}
          </button>
        );
      })}
      {failed && <span className="ml-1 text-[11px] text-warn">保存できず</span>}
    </span>
  );
}
