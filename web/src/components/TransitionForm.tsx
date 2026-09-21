"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { CuePad, LoopTag } from "@/components/CuePad";
import { usePerformance } from "@/components/PerformanceMode";
import type { Cue } from "@/lib/types";
import { barsLabel, cueLabel, formatPosition } from "@/lib/format";
import { DIFFICULTIES, DIFFICULTY_LABEL } from "@/lib/difficulty";
import { RATINGS } from "@/lib/ratings";

/**
 * 繋ぎの入力画面。
 *
 * Notion で直接入力すると、キューのピッカーに全曲ぶんの候補が出てしまう
 * （リレーションの候補を他プロパティで絞る機能が Notion に無い）。
 * ここでは **曲を選んだらその曲のキューだけがパッドで並ぶ**。探す作業が消える。
 *
 * 選択肢は rekordbox 由来の実データなので、記号のズレも原理的に起きない。
 */

export type FormTrack = {
  id: string;
  name: string;
  bpm: number | null;
  musicalKey: string;
  cues: Cue[];
};

type Side = "from" | "to";

/** 4つの関連が同じ行が既にあるか。入力は繰り返すので、重複はすぐ起きる */
const keyOf = (a: string, b: string, c: string, d: string) => `${a}|${b}|${c}|${d}`;

export type ListedTransition = {
  id: string;
  from: string;
  to: string;
  /** 曲名に添える BPM。どの繋ぎか見分けるとき、テンポは曲名の次の手掛かりになる */
  fromBpm: number | null;
  toBpm: number | null;
  fromCue: string;
  toCue: string;
  comment: string;
  fromTrackId: string;
  fromCueId: string;
  toTrackId: string;
  toCueId: string;
  technique: string | null;
  rating: string | null;
  bars: number | null;
  barsAfter: number | null;
  practice: boolean;
  difficulty: string | null;
  chain: string;
};

export function TransitionForm({
  tracks, existing, chains, transitions, initialFromId, initialToId, initialEditId,
}: {
  tracks: FormTrack[];
  existing: string[];
  chains: string[];
  transitions: ListedTransition[];
  /** 曲ページ・グラフから来たときの初期選択。知らない ID は未選択として扱う */
  initialFromId?: string;
  initialToId?: string;
  /** `?edit=` で開いたときの編集対象。曲ページ・グラフの「編集」から来る */
  initialEditId?: string;
}) {
  const router = useRouter();
  const { on: performing, toggle: togglePerformance } = usePerformance();
  const initial = (id: string | undefined) => tracks.find((t) => t.id === id) ?? null;
  const initialCue = (trackId: string | undefined, cueId: string | undefined) =>
    initial(trackId)?.cues.find((c) => c.id === cueId) ?? null;
  /** `?edit=` で名指しされた行。あればフォームは最初から編集モードで開く */
  const editRow = initialEditId ? transitions.find((t) => t.id === initialEditId) ?? null : null;

  // 曲だけ入れてキューは選ばない。次に押すのはパッドで、そこが入力の本体
  // （編集で開いたときだけ、その行のキューまで入れる）
  const [fromTrack, setFromTrack] = useState<FormTrack | null>(
    () => initial(editRow?.fromTrackId ?? initialFromId),
  );
  const [fromCue, setFromCue] = useState<Cue | null>(
    () => initialCue(editRow?.fromTrackId, editRow?.fromCueId),
  );
  const [toTrack, setToTrack] = useState<FormTrack | null>(
    () => initial(editRow?.toTrackId ?? initialToId),
  );
  const [toCue, setToCue] = useState<Cue | null>(
    () => initialCue(editRow?.toTrackId, editRow?.toCueId),
  );

  const [technique, setTechnique] = useState<string | null>(editRow?.technique ?? null);
  const [rating, setRating] = useState<string | null>(editRow?.rating ?? null);
  const [difficulty, setDifficulty] = useState<string | null>(editRow?.difficulty ?? null);
  // 小節数は「TO の何小節前から」と「何小節後から」の2項目。**入るのは片方だけ**
  // （片方に数が入っている間、もう片方は塞ぐ。API 側でも両方入りを弾いている）
  const [bars, setBars] = useState(editRow?.bars == null ? "" : String(editRow.bars));
  const [barsAfter, setBarsAfter] = useState(editRow?.barsAfter == null ? "" : String(editRow.barsAfter));
  const [practice, setPractice] = useState(editRow?.practice ?? false);
  const [chain, setChain] = useState(editRow?.chain ?? "");
  const [comment, setComment] = useState(editRow?.comment ?? "");

  const [rows, setRows] = useState(transitions);
  /**
   * サーバから新しい一覧が来たらそちらに従う（`router.refresh()` の結果を拾う）。
   * 画面に出したままの行が Notion の中身とズレるのが、入力後にいちばん困る。
   */
  const [seenTransitions, setSeenTransitions] = useState(transitions);
  if (seenTransitions !== transitions) { setSeenTransitions(transitions); setRows(transitions); }
  /** 編集中の繋ぎ。null なら新規追加 */
  const [editingId, setEditingId] = useState<string | null>(editRow?.id ?? null);
  /**
   * FROM / TO の枠を作り直すための番号。
   * 枠は自前で「曲の検索文字」を持っているので、フォームを畳んだときに
   * 番号を進めて作り直す。これをしないと、次の入力で**前回の検索で絞られたまま**の
   * 曲一覧が出る（保存直後の「何か残っている」画面の正体）。
   */
  const [formSeq, setFormSeq] = useState(0);
  const [listQ, setListQ] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 最後に保存できたときのフォームの中身（`formKey`）。今の中身と同じ間だけ
   * 「入力が完了しました」を出す。どこか1つでも触れば消え、「この繋ぎを更新」が押せるようになる。
   */
  const [savedKey, setSavedKey] = useState<string | null>(null);
  /**
   * フォームを別の行・新しい入力へ切り替えた回数。保存の返事が届く前に切り替えられたら、
   * 届いた返事で編集対象を差し替えない（別の行の中身のまま、新しい行を更新させない）。
   */
  const epochRef = useRef(0);

  const ready = !!(fromTrack && fromCue && toTrack && toCue);
  /** フォームの中身を1本にしたもの。保存した時点と比べて「触ったか」を見る */
  const formKey = JSON.stringify([
    fromTrack?.id ?? null, fromCue?.id ?? null, toTrack?.id ?? null, toCue?.id ?? null,
    technique, rating, difficulty, bars, barsAfter, practice, chain, comment,
  ]);
  const saved = savedKey === formKey;
  /** 小節数の読み下し（`次の曲 C「歌入り」の16小節前`）。組み立ては format.ts の barsLabel だけ */
  const barsSentence = toCue
    ? barsLabel(
        { bars: bars === "" ? null : Number(bars), barsAfter: barsAfter === "" ? null : Number(barsAfter) },
        cueLabel(toCue),
      )
    : null;
  const duplicate =
    ready && !editingId && existing.includes(keyOf(fromTrack.id, fromCue.id, toTrack.id, toCue.id));
  /**
   * 編集中の行そのもの。フォームの削除ボタンはこれを消す。
   * `editingId` ではなく行が見つかったかで出し分ける — 一覧が入れ替わって
   * （`router.refresh()` / 他の画面で消された）行が無いのに削除を押せると、
   * 存在しない行に DELETE を投げることになる。
   */
  const editingRow = editingId ? rows.find((r) => r.id === editingId) ?? null : null;

  const pick = (side: Side, track: FormTrack) => {
    if (side === "from") { setFromTrack(track); setFromCue(null); }
    else { setToTrack(track); setToCue(null); }
  };

  /** フォームを空に戻す。枠ごと作り直して、中の検索文字も残さない */
  const clearForm = () => {
    setFromTrack(null); setFromCue(null); setToTrack(null); setToCue(null);
    setTechnique(null); setRating(null); setDifficulty(null); setBars(""); setBarsAfter(""); setPractice(false);
    setChain(""); setComment("");
    setFormSeq((n) => n + 1);
  };

  /**
   * 次の1件を入れ始める（「新しい繋ぎを入力する」「To の曲から続けて入力する」「編集をやめる」）。
   * フォームを空に戻し、`from` を渡されたらその曲を From に入れる。
   *
   * URL も `/new`（続けて入力なら `/new?from=`）に揃えるが、**`router.replace` で移る。
   * `history.replaceState` で書き換えてはいけない** — page.tsx は `from` / `to` / `edit` から
   * このフォームの key を作っている。サーバが描いたときと違う URL のまま、保存のたびに呼ぶ
   * `router.refresh()` が走ると key が変わってフォームが作り直され、入れたばかりの内容と
   * 「入力が完了しました」が消える（「編集をやめる」→ 新しく入力 → 保存、で実際に起きた）。
   */
  const startNew = (from: FormTrack | null = null, { scroll = true } = {}) => {
    epochRef.current += 1;
    setEditingId(null);
    clearForm();
    setFromTrack(from);
    setSavedKey(null); setError(null);
    const target = from ? `/new?from=${encodeURIComponent(from.id)}` : "/new";
    if (window.location.pathname + window.location.search !== target) {
      router.replace(target, { scroll: false });
    }
    // 下で保存ボタンを押した指のまま空のフォームを見せると、また「全部消えた」に見える
    if (scroll) window.scrollTo({ top: 0 });
  };

  const save = async () => {
    if (!ready) return;
    // 返事が届くまでにフォームを別の行・新しい入力へ切り替えられたら、そちらを優先する
    const epoch = epochRef.current;
    const key = formKey;
    setBusy(true); setError(null);
    try {
      const payload = {
        fromTrackId: fromTrack.id, fromCueId: fromCue.id,
        toTrackId: toTrack.id, toCueId: toCue.id,
        technique, rating, difficulty, bars, barsAfter, practice, chain, comment,
      };
      const res = await fetch("/api/transitions", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingId ? { id: editingId, ...payload } : payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "保存に失敗しました");

      const id: string = editingId ?? data.id;
      const row: ListedTransition = {
        id,
        from: fromTrack.name, to: toTrack.name,
        fromBpm: fromTrack.bpm, toBpm: toTrack.bpm,
        fromCue: cueLabel(fromCue),
        toCue: cueLabel(toCue),
        comment,
        fromTrackId: fromTrack.id, fromCueId: fromCue.id,
        toTrackId: toTrack.id, toCueId: toCue.id,
        technique, rating, difficulty,
        bars: bars === "" ? null : Number(bars),
        barsAfter: barsAfter === "" ? null : Number(barsAfter),
        practice, chain,
      };

      setRows((cur) => (editingId ? cur.map((r) => (r.id === id ? row : r)) : [row, ...cur]));
      if (epochRef.current === epoch) {
        /*
          入れた内容は消さない。この行の編集に切り替えて「入力が完了しました」とだけ返す
          （次に押すと同じ行を書き換える = 同じ繋ぎが2行にならない）。
          以前は保存と同時にフォームを空にして To を From へ送っていたが、押した指の先で
          中身が入れ替わり、返事は画面の上端（見えない所）に出るので、壊れたように見えた。
          次の1件は、完了の下に出る「新しい繋ぎを入力する」から始める
        */
        setEditingId(id);
        setSavedKey(key);
      }
      // Notion に書けた分をサーバから取り直す。重複の注意書き・登録済み一覧・
      // 他のページ（曲・グラフ）が、画面に出ている内容とズレたままになるのを防ぐ。
      // URL は触らないので key は変わらず、フォームはこのまま残る（startNew の注意書き）
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  /** 一覧の行をフォームに戻す。キューの付け替えも同じ選択肢からできる */
  const startEdit = (row: ListedTransition) => {
    epochRef.current += 1;
    const ft = tracks.find((t) => t.id === row.fromTrackId) ?? null;
    const tt = tracks.find((t) => t.id === row.toTrackId) ?? null;
    setFromTrack(ft); setFromCue(ft?.cues.find((c) => c.id === row.fromCueId) ?? null);
    setToTrack(tt); setToCue(tt?.cues.find((c) => c.id === row.toCueId) ?? null);
    setTechnique(row.technique); setRating(row.rating); setDifficulty(row.difficulty);
    setBars(row.bars == null ? "" : String(row.bars));
    setBarsAfter(row.barsAfter == null ? "" : String(row.barsAfter));
    setPractice(row.practice);
    setChain(row.chain); setComment(row.comment);
    setEditingId(row.id);
    setFormSeq((n) => n + 1); // 枠を作り直して、前の検索文字を残さない
    setSavedKey(null); setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const remove = async (row: ListedTransition) => {
    if (!window.confirm(`${row.from} → ${row.to} を削除しますか？`)) return;
    setRemoving(row.id); setError(null);
    try {
      const res = await fetch(`/api/transitions?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json())?.error ?? "削除に失敗しました");
      setRows((cur) => cur.filter((r) => r.id !== row.id));
      // 消した行を編集中だったら、フォームも畳む（存在しない行を保存させない）。
      // 一覧の途中で消した人を上へ飛ばさない
      if (editingId === row.id) startNew(null, { scroll: false });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setRemoving(null);
    }
  };

  /*
    本番中はこの画面そのものを閉じる。
    入口（下タブの「入力」・各ページの「繋ぎを追加」）は CSS で畳んであるが、
    URL を直に開ける以上、書ける画面が残っていては「編集できないモード」にならない。
  */
  if (performing) {
    return (
      <main className="relative z-1 mx-auto max-w-[820px] px-4 pb-nav pt-5 md:pb-16">
        <h1 className="text-[22px] font-bold leading-tight">パフォーマンスモード中です</h1>
        <p className="mt-2 text-[13.5px] text-fg-muted">
          本番中に記録が書き換わらないよう、入力・編集は畳んでいます。
        </p>
        <button
          type="button"
          onClick={togglePerformance}
          className="tap mt-5 h-12 rounded-card border border-hot/60 bg-hot/15 px-6 text-[15px] font-semibold text-hot"
        >
          解除して入力する
        </button>
      </main>
    );
  }

  const shownRows = rows.filter((r) => {
    const q = listQ.trim().toLowerCase();
    return !q || `${r.from} ${r.to} ${r.fromCue} ${r.toCue} ${r.comment}`.toLowerCase().includes(q);
  });

  return (
    <main className="relative z-1 mx-auto max-w-[820px] px-4 pb-nav pt-5 md:pb-16">
      <div className="flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-[22px] font-bold leading-tight">
          {editingId ? "繋ぎを編集" : "繋ぎを追加"}
        </h1>
        {editingId && (
          <button
            type="button"
            onClick={() => startNew()}
            // 保存の返事を待っている間に切り替えると、どの行を編集しているのかが宙に浮く
            disabled={busy}
            className="tap shrink-0 rounded-full border border-border px-4 text-[12px] text-fg-subtle hover:text-fg disabled:opacity-40"
          >
            編集をやめる
          </button>
        )}
      </div>
      <p className="mt-1 text-[13px] text-fg-muted">
        {editingId
          ? "曲もキューも選び直せます。保存すると同じ行を書き換えます。"
          : "曲を選ぶと、その曲のホットキューだけが並びます。書き込み先は 🔀Transitions です。"}
      </p>

      <Side
        key={`from-${formSeq}`}
        label="FROM · どの曲のどこから抜けるか"
        tracks={tracks}
        track={fromTrack}
        cue={fromCue}
        onTrack={(t) => pick("from", t)}
        onCue={setFromCue}
        onClear={() => { setFromTrack(null); setFromCue(null); }}
      />

      <div className="my-2 text-center text-[20px] text-hot">↓</div>

      <Side
        key={`to-${formSeq}`}
        label="TO · どの曲のどこへ入るか"
        tracks={tracks}
        track={toTrack}
        cue={toCue}
        onTrack={(t) => pick("to", t)}
        onCue={setToCue}
        onClear={() => { setToTrack(null); setToCue(null); }}
      />

      {/* ── 任意項目 ── */}
      <section className="mt-6 space-y-4 rounded-card border border-border bg-surface p-4">
        <h2 className="label">任意</h2>

        <div>
          <span className="label">種類</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {["同時流し", "ループ合わせ", "カット", "ビート合わせ"].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTechnique((cur) => (cur === t ? null : t))}
                className={chipClass(technique === t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="label">評価</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {RATINGS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRating((cur) => (cur === r ? null : r))}
                className={chipClass(rating === r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* 難易度。/play の「◯まで」で、本番で難しい繋ぎを外すのに使う（未入力は外さない） */}
        <div>
          <span className="label">難易度</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {DIFFICULTIES.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDifficulty((cur) => (cur === d ? null : d))}
                className={chipClass(difficulty === d)}
              >
                {DIFFICULTY_LABEL[d]}
              </button>
            ))}
          </div>
        </div>

        {/*
          小節数は「TO の何小節前から」と「何小節後から」の2項目。
          繋ぎ始めが TO キューより前のことも後のこともあるので、両方を置いてある。
          **入るのは片方だけ** — 片方に数が入っている間、もう片方は塞ぐ
          （両方入ると「何小節ずらすか」の答えが2つある行になる。API 側でも弾く）。
        */}
        <div>
          <span className="label">小節数 · TO のキューから何小節ずらして始めるか</span>
          <div className="mt-1.5 flex flex-wrap gap-3">
            <label className="flex-1 min-w-[140px]">
              <span className="text-[11.5px] text-fg-subtle">何小節<b className="text-fg-muted">前</b>から</span>
              <input
                type="number"
                inputMode="numeric"
                value={bars}
                onChange={(e) => setBars(e.target.value)}
                disabled={barsAfter !== ""}
                placeholder="16"
                className="mt-1 h-12 w-full rounded-card border border-border bg-surface-2 px-3 font-mono text-[16px] outline-none placeholder:text-fg-subtle focus:border-accent disabled:opacity-40"
              />
            </label>
            <label className="flex-1 min-w-[140px]">
              <span className="text-[11.5px] text-fg-subtle">何小節<b className="text-fg-muted">後</b>から</span>
              <input
                type="number"
                inputMode="numeric"
                value={barsAfter}
                onChange={(e) => setBarsAfter(e.target.value)}
                disabled={bars !== ""}
                placeholder="8"
                className="mt-1 h-12 w-full rounded-card border border-border bg-surface-2 px-3 font-mono text-[16px] outline-none placeholder:text-fg-subtle focus:border-accent disabled:opacity-40"
              />
            </label>
          </div>
          {/* 意味の取り違えがいちばん怖い項目なので、読み下した文をその場で返す */}
          {barsSentence && (
            <span className="mt-1 block text-[11.5px] text-fg-subtle">{barsSentence}</span>
          )}
          {(bars !== "" || barsAfter !== "") && (
            <span className="mt-1 block text-[11px] text-fg-subtle">
              入るのはどちらか片方です。入れ直すときは、入っている方を空にしてください。
            </span>
          )}
        </div>

        {/*
          要練習マーク。今までは保存したあとに曲ページ・グラフ・/practice で押すしかなく、
          「入れながら、これは練習が要る」と分かっている繋ぎを一手で残せなかった
        */}
        <div>
          <span className="label">要練習</span>
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() => setPractice((v) => !v)}
              aria-pressed={practice}
              title="次の練習で拾う繋ぎに付ける（/practice に一覧が出る）"
              className={`tap inline-flex items-center rounded-full border px-4 text-[13px] transition-colors ${
                practice
                  ? "border-warn/60 bg-warn/12 text-warn"
                  : "border-border bg-surface-2 text-fg-muted hover:text-fg"
              }`}
            >
              {practice ? "⚑ 要練習" : "要練習"}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <label className="flex-1 min-w-[140px]">
            <span className="label">チェーン</span>
            <input
              list="chain-list"
              value={chain}
              onChange={(e) => setChain(e.target.value)}
              placeholder="chain6 など"
              className="mt-1.5 h-12 w-full rounded-card border border-border bg-surface-2 px-3 text-[16px] outline-none placeholder:text-fg-subtle focus:border-accent"
            />
            <datalist id="chain-list">
              {chains.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
        </div>

        <label className="block">
          <span className="label">コメント</span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="EとCの20小節前と合わせる など"
            className="mt-1.5 w-full rounded-card border border-border bg-surface-2 px-3 py-2.5 text-[16px] leading-relaxed outline-none placeholder:text-fg-subtle focus:border-accent"
          />
        </label>
      </section>

      {duplicate && (
        <p className="mt-3 text-[13px] text-warn">
          同じ組み合わせの繋ぎが既にあります。追加すると2行になります。
        </p>
      )}
      {error && <p className="mt-3 text-[13px] text-warn">{error}</p>}

      {/* 保存ボタン。登録済み一覧の上、右寄せ。編集中はその左に削除 */}
      <div className="mt-5 flex justify-end gap-2">
        {/*
          グラフ・曲ページ・練習一覧の「編集」（`?edit=`）から来た人は、
          間違って入れた繋ぎをここで消せる。それらの入口に削除は無く、
          今までは下の一覧から同じ行を探し直す必要があった。
          消す対象は**保存済みの行**なので、フォームで曲を選び直していても
          確認文には元の曲名が出る（消えるのはその行だから）。
        */}
        {editingRow && (
          <button
            type="button"
            onClick={() => remove(editingRow)}
            disabled={removing === editingRow.id || busy}
            className="tap h-12 rounded-card border border-border px-6 text-[15px] text-fg-subtle transition-colors hover:border-warn/60 hover:text-warn disabled:opacity-35"
          >
            {removing === editingRow.id ? "削除中…" : "この繋ぎを削除"}
          </button>
        )}
        <button
          type="button"
          onClick={save}
          // 保存した直後で何も触っていない間は押せない（同じ中身を書き直すだけになる）
          disabled={!ready || busy || saved}
          className="tap h-12 rounded-card border border-hot/60 bg-hot/15 px-8 text-[15px] font-semibold text-hot transition-colors disabled:opacity-35"
        >
          {busy ? "保存中…" : !ready ? "From と To を選んでください" : editingId ? "この繋ぎを更新" : "この繋ぎを保存"}
        </button>
      </div>

      {/*
        保存できたら、押したボタンのすぐ下で返事をする（上の見出しの下に出しても、
        下で押した指からは見えない）。ボタンより下に出すのは、押した物を動かさないため。
        入れた内容はそのまま残り、どこかを触れば消えて「更新」に戻る。
        次の1件はここから: 空から入れるか、今の To を From に入れて続けるか
      */}
      {saved && (
        <div role="status" className="mt-3 rounded-card border border-ok/50 bg-ok/10 p-3">
          <p className="px-1 text-[14px] font-semibold text-ok">✓ 入力が完了しました</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => startNew()}
              className="tap min-w-[190px] flex-1 rounded-card border border-hot/60 bg-hot/15 px-4 text-[14px] font-semibold text-hot"
            >
              ＋ 新しい繋ぎを入力する
            </button>
            {toTrack && (
              <button
                type="button"
                onClick={() => startNew(toTrack)}
                title={`From を「${toTrack.name}」にして次の繋ぎを入れる`}
                className="tap min-w-[190px] flex-1 rounded-card border border-border bg-surface-2 px-4 text-[14px] text-fg-muted hover:text-fg"
              >
                To の曲から続けて入力する
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── 登録済みの繋ぎ。間違って入れたものはここから消す ── */}
      <section className="mt-8">
        <div className="flex items-center gap-2">
          <h2 className="label">登録済みの繋ぎ · {rows.length}</h2>
          <input
            value={listQ}
            onChange={(e) => setListQ(e.target.value)}
            placeholder="曲名で絞る"
            className="ml-auto h-10 w-[46%] rounded-card border border-border bg-surface-2 px-3 text-[14px] outline-none placeholder:text-fg-subtle focus:border-accent"
          />
        </div>
        <ul className="mt-2 space-y-1.5">
          {shownRows.map((r) => (
            <li
              key={r.id}
              className="flex items-start gap-2 rounded-card border border-border bg-surface px-3 py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] break-words">
                  {r.from}<Bpm value={r.fromBpm} /> <span className="text-hot">→</span> {r.to}
                  <Bpm value={r.toBpm} />
                </span>
                <span className="block font-mono text-[11.5px] text-fg-subtle break-words">
                  {r.fromCue} → {r.toCue}
                </span>
                {r.comment && <span className="block text-[12px] text-fg-muted break-words">{r.comment}</span>}
              </span>
              <button
                type="button"
                onClick={() => startEdit(r)}
                className={`tap shrink-0 rounded-full border px-3 text-[12px] transition-colors ${
                  editingId === r.id
                    ? "border-accent/60 bg-accent/12 text-accent"
                    : "border-border text-fg-muted hover:border-border-bright hover:text-fg"
                }`}
              >
                編集
              </button>
              <button
                type="button"
                onClick={() => remove(r)}
                disabled={removing === r.id}
                className="tap shrink-0 rounded-full border border-border px-3 text-[12px] text-fg-subtle transition-colors hover:border-warn/60 hover:text-warn disabled:opacity-40"
              >
                {removing === r.id ? "…" : "削除"}
              </button>
            </li>
          ))}
          {shownRows.length === 0 && (
            <li className="rounded-card border border-border bg-surface px-3 py-3 text-[13px] text-fg-subtle">
              {rows.length === 0 ? "まだ繋ぎがありません" : "見つかりません"}
            </li>
          )}
        </ul>
      </section>

    </main>
  );
}

/**
 * 曲名の後ろに添える BPM。曲名の続きとして折り返させたいので inline で置くが、
 * 数と単位の間では折らない（`132` / `BPM` に割れると別の数に読める）
 */
const Bpm = ({ value }: { value: number | null }) => (
  <span className="ml-1.5 whitespace-nowrap font-mono text-[11px] tabular-nums text-fg-subtle">
    {value ?? "–"}
    <span className="ml-0.5 text-[9px] tracking-wide">BPM</span>
  </span>
);

const chipClass = (on: boolean) =>
  `tap rounded-full border px-4 text-[13px] transition-colors ${
    on ? "border-accent/60 bg-accent/12 text-accent" : "border-border bg-surface-2 text-fg-muted hover:text-fg"
  }`;

/** FROM / TO の片側。曲を選ぶ → その曲のキューだけがパッドで並ぶ */
function Side({
  label, tracks, track, cue, onTrack, onCue, onClear,
}: {
  label: string;
  tracks: FormTrack[];
  track: FormTrack | null;
  cue: Cue | null;
  onTrack: (t: FormTrack) => void;
  onCue: (c: Cue) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return tracks;
    return tracks.filter((t) => query.split(/\s+/).every((w) => t.name.toLowerCase().includes(w)));
  }, [q, tracks]);

  return (
    <section className="mt-4 rounded-card border border-border bg-surface p-4">
      <h2 className="label">{label}</h2>

      {track ? (
        <div className="mt-2 flex items-start gap-2">
          <p className="min-w-0 flex-1 text-[16px] font-semibold break-words">
            {track.name}
            {/* 「132 BPM · C」は1つの札。曲名が長いときは札ごと次の行へ送る（途中で割らない） */}
            <span className="ml-2 whitespace-nowrap font-mono text-[12px] font-normal tabular-nums text-fg-muted">
              {track.bpm ?? "–"} BPM{track.musicalKey && ` · ${track.musicalKey}`}
            </span>
          </p>
          <button
            type="button"
            onClick={() => { setQ(""); onClear(); }}
            className="tap shrink-0 rounded-full border border-border px-3 text-[12px] text-fg-subtle hover:text-fg"
          >
            変更
          </button>
        </div>
      ) : null}

      {!track && (
        <>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="曲を検索"
            className="mt-2 h-12 w-full rounded-card border border-border bg-surface-2 px-3 text-[16px] outline-none placeholder:text-fg-subtle focus:border-accent"
          />
          <ul className="mt-2 max-h-[260px] overflow-y-auto rounded-card border border-border divide-y divide-border">
            {shown.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onTrack(t)}
                  className="tap flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 text-[14px] break-words">{t.name}</span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                    {t.cues.length}キュー
                  </span>
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-3 py-3 text-[13px] text-fg-subtle">見つかりません</li>
            )}
          </ul>
        </>
      )}

      {track && (
        <div className="mt-3">
          {track.cues.length === 0 ? (
            <p className="rounded-card border border-warn/40 bg-warn/8 px-3 py-2.5 text-[13px] text-fg-muted">
              この曲にはホットキューが登録されていません。rekordbox でキューを打ってから
              <code className="mx-1 font-mono text-[12px]">tools/sync.py</code>
              を回すと出てきます（アプリ側の反映は最大5分）。
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {track.cues.map((c) => {
                const on = cue?.id === c.id;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => onCue(c)}
                      className={`tap flex w-full items-center gap-2.5 rounded-card border px-2.5 py-2 text-left transition-colors ${
                        on ? "border-accent bg-accent/10" : "border-border bg-surface-2 hover:border-border-bright"
                      }`}
                    >
                      <CuePad cue={c} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 text-[14px] break-words">
                          {c.name || <span className="text-fg-subtle">（名前なし）</span>}
                          <LoopTag cue={c} />
                        </span>
                        <span className="block font-mono text-[11px] tabular-nums text-fg-subtle">
                          {formatPosition(c.positionMs)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
