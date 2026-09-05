"use client";

import { useState } from "react";

/**
 * 要練習マーク（🔀Transitions の「要練習」チェックボックス）をその場で付け外しする。
 *
 * 星（`RatingPicker`）と同じ思想: 「ここ練習したい」と思うのはグラフや曲ページを
 * 見ている最中なので、入力画面へ戻らせない。押した瞬間に見た目を変え、
 * 失敗したときだけ元に戻す。マークした繋ぎは /practice に一覧で出る。
 *
 * **リンクやカードの中に置く前提**なので、クリックは必ず止める（親のページ遷移を殺す）。
 */
export function PracticeToggle({
  id, value, className = "",
}: {
  /** 🔀Transitions のページID */
  id: string;
  value: boolean;
  className?: string;
}) {
  /** 押した結果。null = まだ押していない（= サーバの値をそのまま出す） */
  const [pressed, setPressed] = useState<boolean | null>(null);
  const [seenValue, setSeenValue] = useState(value);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // サーバから新しい値が来たらそちらに従う（別の画面で変えた分を拾う）
  if (seenValue !== value) { setSeenValue(value); setPressed(null); }

  const on = pressed ?? value;

  const toggle = async () => {
    const before = on;
    setPressed(!before); setBusy(true); setFailed(false);
    try {
      const res = await fetch("/api/transitions/practice", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, practice: !before }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setPressed(before);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 ${className}`}
      // カードの中に居るので、ここで押されたものは親へ渡さない
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {failed && <span className="text-[11px] text-warn">保存できず</span>}
      <button
        type="button"
        disabled={busy}
        onClick={toggle}
        aria-pressed={on}
        title={on ? "要練習マークを外す" : "次の練習で拾う繋ぎに付ける（/practice に一覧が出る）"}
        className={`tap inline-flex items-center rounded-full border px-3 text-[12px] transition-colors ${
          on
            ? "border-warn/60 bg-warn/12 text-warn"
            : "border-border text-fg-subtle hover:border-border-bright hover:text-fg"
        } ${busy ? "opacity-60" : ""}`}
      >
        {on ? "⚑ 要練習" : "要練習"}
      </button>
    </span>
  );
}
