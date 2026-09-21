"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RATINGS, ratingOf, starCount } from "@/lib/ratings";

/**
 * 星（🔀Transitions の「評価」）をその場で付け替える。
 *
 * 練習中に「今の繋ぎ良かった」と思うのはグラフや曲ページを見ている最中で、
 * そのために入力画面へ戻るのは遅い。押した瞬間に見た目を変え、
 * 失敗したときだけ元に戻す（DJ 中に保存待ちで固まらせない）。
 *
 * **リンクやカードの中に置く前提**なので、クリックは必ず止める（親のページ遷移を殺す）。
 */
export function RatingPicker({
  id, value, size = "md", className = "", refresh = true,
}: {
  /** 🔀Transitions のページID */
  id: string;
  value: string | null;
  size?: "sm" | "md";
  className?: string;
  /** 保存できたら画面を取り直すか。グラフのパネルでは false（PracticeToggle と同じ理由） */
  refresh?: boolean;
}) {
  const router = useRouter();
  /** 押した結果。null = まだ押していない（= サーバの値をそのまま出す） */
  const [pressed, setPressed] = useState<number | null>(null);
  const [seenValue, setSeenValue] = useState(value);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // サーバから新しい値が来たらそちらに従う（別の画面で変えた分を拾う）
  if (seenValue !== value) { setSeenValue(value); setPressed(null); }

  const stars = pressed ?? starCount(value);

  const set = async (next: number) => {
    const before = stars;
    setPressed(next); setBusy(true); setFailed(false);
    try {
      const res = await fetch("/api/transitions/rating", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, rating: ratingOf(next) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "保存に失敗しました");
      // revalidateTag が捨てるのはサーバのキャッシュだけで、端末のルーターキャッシュ（他の画面・
      // 戻る/進む）には最大5分前の星が残る。取り直した値は上の seenValue が拾う（PracticeToggle と同じ）
      if (refresh) router.refresh();
    } catch {
      setPressed(before);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const box = size === "sm" ? "size-7 text-[14px]" : "size-9 text-[17px]";

  return (
    <span
      className={`inline-flex items-center ${className}`}
      role="group"
      aria-label="評価"
      // カードの中に居るので、ここで押されたものは親へ渡さない
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {RATINGS.map((_, i) => {
        const n = i + 1;
        const on = n <= stars;
        return (
          <button
            key={n}
            type="button"
            disabled={busy}
            // 同じ星をもう一度押したら評価を外す（消し方が他に無いと詰む）
            onClick={() => set(stars === n ? 0 : n)}
            aria-label={`星${n}${stars === n ? "（もう一度押すと外す）" : ""}`}
            aria-pressed={on}
            className={`grid ${box} place-items-center rounded leading-none transition-colors ${
              on ? "text-hot" : "text-fg-subtle/50 hover:text-fg-subtle"
            } ${busy ? "opacity-60" : ""}`}
          >
            {on ? "★" : "☆"}
          </button>
        );
      })}
      {failed && <span className="ml-1.5 text-[11px] text-warn">保存できず</span>}
    </span>
  );
}
