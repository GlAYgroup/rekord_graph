"use client";

import { useState } from "react";

/**
 * 繋ぎのコメント（🔀Transitions の「コメント」）をその場で書き足す・直す。
 *
 * 星（`RatingPicker`）・要練習（`PracticeToggle`）と同じ思想: 「ここはこう繋ぐ」と書き残したくなるのは
 * `/play` で下見をしている最中なので、入力画面へ戻らせない。書くのはコメントの列だけ
 * （`/api/transitions/comment`）で、種類・小節数などは触らない。
 *
 * 星と違って**書いた文を失わない方を取る**: 押した瞬間に閉じず、保存できてから閉じる。
 * 失敗したら開いたまま、書いた文を残して知らせる（閉じて戻すと、打った文が消える）。
 * 画面の取り直しはしない — 保存できた文は `onSaved` で親に返し、親が手元の行を書き換える。
 */
export function CommentEditor({
  id, value, onSaved, onClose,
}: {
  /** 🔀Transitions のページID */
  id: string;
  /** 今のコメント。書き足すときも、ここから続けて書く */
  value: string;
  /** 保存できた文（前後の空白を落としたもの）を親へ返す */
  onSaved: (comment: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 何も変えていない間は保存を押させない（同じ文を書き直すだけになる） */
  const unchanged = draft.trim() === value.trim();

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/transitions/comment", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, comment: draft }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "保存に失敗しました");
      onSaved(typeof data?.comment === "string" ? data.comment : draft.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 pb-2 pt-1">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        // 開いたらすぐ打てるように（押したのは「書きたい」から）
        autoFocus
        placeholder="EとCの20小節前と合わせる など"
        aria-label="コメント"
        // 16px 未満だと iPhone は入力のたびに画面を拡大する
        className="w-full rounded-card border border-border bg-surface-2 px-3 py-2.5 text-[16px] leading-relaxed outline-none placeholder:text-fg-subtle focus:border-accent"
      />
      {error && <p className="text-[12.5px] text-warn">{error}（書いた文は残してあります）</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || unchanged}
          className="tap flex-1 rounded-card border border-hot/60 bg-hot/15 px-4 text-[14px] font-semibold text-hot transition-colors disabled:opacity-35"
        >
          {busy ? "保存中…" : "コメントを保存"}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="tap flex-1 rounded-card border border-border bg-surface px-4 text-[14px] text-fg-muted hover:text-fg disabled:opacity-40"
        >
          やめる
        </button>
      </div>
    </div>
  );
}
