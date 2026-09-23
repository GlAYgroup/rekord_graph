"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { minutesLabel, timingOf } from "@/lib/duration";
import { barsLabel, cueLabel } from "@/lib/format";
import { alignHops, checkPlaylist, type Playlist } from "@/lib/playlist";
import { readPlan, writePlan } from "@/lib/playlog";
import type { Cue, Track, Transition } from "@/lib/types";

/**
 * 1本のプレイリストを並べる画面。**下書きを手元で直して、「保存」で1回だけ Notion に書く**
 * （並べ替えの1タップごとに書くと Notion の上限に当たる）。
 *
 * - 曲と曲の間には、使う繋ぎ（どのキューからどのキューへ）を出す。同じ2曲の間に複数あれば選べる。
 *   並べ替えても、選んでいた繋ぎがその2曲を結ぶなら残す（`alignHops`）
 * - /play の約束を破る並び（繋ぎなし・時間が逆行する・同じ曲が2回）は**止めずに警告**する
 *   （まだ繋ぎを入れていない曲も、イベントのために先に並べておけるように）
 * - 「この順で /play を始める」は最初の曲から /play を開き、間の繋ぎに「予定」の印を付けさせる
 *   （`PlayPlan.route` だけを書き換える。「セットを組む」で選んだ曲は残す）
 * - rekordbox へは PC で `tools/rb_playlist.py` を回す（アプリからは master.db に触れない）
 */
export function PlaylistEditor({
  playlist, tracks, cues, transitions,
}: {
  playlist: Playlist;
  tracks: Track[];
  cues: Cue[];
  transitions: Transition[];
}) {
  const router = useRouter();
  const byRb = useMemo(() => new Map(tracks.map((t) => [t.rekordboxId, t])), [tracks]);
  const trackById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const cueById = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);
  const transitionById = useMemo(() => new Map(transitions.map((t) => [t.id, t])), [transitions]);
  const lookup = useMemo(() => ({
    durationSec: (id: string) => trackById.get(id)?.durationSec ?? null,
    bpm: (id: string) => trackById.get(id)?.bpm ?? null,
    cueMs: (id: string) => cueById.get(id)?.positionMs ?? null,
  }), [trackById, cueById]);
  const timing = useMemo(() => (t: Transition) => timingOf(t, lookup), [lookup]);
  const songOf = useMemo(() => (id: string) => trackById.get(id)?.songId ?? id, [trackById]);
  /** rekordbox の ContentID -> 曲ID。rekordbox から消えた曲は `rb:<ID>`（どの繋ぎにも当たらない） */
  const idOf = (rb: string) => byRb.get(rb)?.id ?? `rb:${rb}`;

  const [name, setName] = useState(playlist.name);
  const [date, setDate] = useState(playlist.date ?? "");
  const [memo, setMemo] = useState(playlist.memo);
  const [items, setItems] = useState<string[]>(playlist.trackRbIds);
  /**
   * 開いた時点の繋ぎ。保存された繋ぎが消えていたり、後から繋ぎが記録されていたりすると
   * 揃え直した分だけ保存値と違うので、「直したか」はこちらと比べる（開いただけで「保存する」を出さない）
   */
  const openedHops = useMemo(
    () => alignHops(playlist.trackRbIds.map((rb) => byRb.get(rb)?.id ?? `rb:${rb}`), playlist.hops, transitions),
    // 保存して props が新しくなったら、比べる相手もそれに合わせる（保存後も「保存する」が残らないように）
    [playlist, transitions, byRb],
  );
  const [hops, setHops] = useState(openedHops);
  const trackIds = useMemo(() => items.map((rb) => byRb.get(rb)?.id ?? `rb:${rb}`), [items, byRb]);

  /** 並びを変えたら、間の繋ぎを揃え直す（選んでいた繋ぎは残す） */
  const reorder = (next: string[]) => {
    setItems(next);
    setHops(alignHops(next.map(idOf), hops, transitions));
    setSaved(false);
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    reorder(next);
  };
  const remove = (i: number) => reorder(items.filter((_, j) => j !== i));
  const add = (t: Track) => reorder([...items, t.rekordboxId]);
  const chooseHop = (i: number, id: string) => {
    setHops((cur) => cur.map((h, j) => (j === i ? id : h)));
    setSaved(false);
  };

  const issues = useMemo(
    () => checkPlaylist(trackIds, hops, songOf, transitionById, timing),
    [trackIds, hops, songOf, transitionById, timing],
  );
  const noHop = new Set(issues.filter((x) => x.kind === "noHop").map((x) => x.index));
  const reversed = new Set(issues.filter((x) => x.kind === "reversed").map((x) => x.index));
  const sameSong = new Map(
    issues.flatMap((x) => (x.kind === "sameSong" ? [[x.index, x.firstIndex] as const] : [])),
  );
  const fullSec = trackIds.reduce((s, id) => s + (trackById.get(id)?.durationSec ?? 0), 0);

  /* ---------- 曲を足す ---------- */
  const [q, setQ] = useState("");
  const lastId = trackIds[trackIds.length - 1] ?? null;
  const usedSongs = new Set(trackIds.map(songOf));
  /** 検索が空なら「今の最後の曲から繋げる先」を出す（次に足すのはたいていそこから） */
  const suggestions = useMemo(() => {
    const words = q.normalize("NFKC").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      if (!lastId) return [];
      const seen = new Set<string>();
      return transitions
        .filter((t) => t.fromTrackId === lastId)
        .map((t) => trackById.get(t.toTrackId))
        .filter((t): t is Track => !!t && !seen.has(t.id) && !!seen.add(t.id));
    }
    return tracks
      .filter((t) => words.every((w) => `${t.name} ${t.alias} ${t.fullTitle}`.normalize("NFKC").toLowerCase().includes(w)))
      .sort((a, b) => a.name.localeCompare(b.name, "ja"))
      .slice(0, 40);
  }, [q, lastId, transitions, trackById, tracks]);

  /* ---------- 保存・削除 ---------- */
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty =
    name !== playlist.name || date !== (playlist.date ?? "") || memo !== playlist.memo ||
    items.join(" ") !== playlist.trackRbIds.join(" ") || hops.join(" ") !== openedHops.join(" ");

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: playlist.id, name, date: date || null, memo, trackRbIds: items, hops }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `保存できませんでした（${res.status}）`);
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const destroy = async () => {
    setBusy(true); setError(null);
    const res = await fetch(`/api/playlists?id=${encodeURIComponent(playlist.id)}`, { method: "DELETE" });
    if (res.ok) { router.push("/playlists"); router.refresh(); return; }
    setError((await res.json().catch(() => null))?.error ?? `削除できませんでした（${res.status}）`);
    setBusy(false);
  };
  /** /play へ渡すのは道筋（繋ぎID）だけ。「セットを組む」で選んだ曲は残す */
  const startPlay = () =>
    writePlan({ ...readPlan(), route: hops.filter((h): h is string => h !== null) });

  const btn = "tap grid size-9 shrink-0 place-items-center rounded-full border border-border text-[13px] text-fg-muted hover:text-fg disabled:opacity-30";

  return (
    <main className="relative z-1 mx-auto max-w-2xl px-4 pb-nav pt-4">
      <div className="flex items-start gap-2">
        <input
          data-edit
          value={name}
          onChange={(e) => { setName(e.target.value); setSaved(false); }}
          aria-label="プレイリストの名前"
          className="min-w-0 flex-1 rounded-card border border-transparent bg-transparent px-1 text-[22px] font-bold tracking-tight outline-none hover:border-border focus:border-accent"
        />
        <Link
          href="/playlists"
          className="tap shrink-0 rounded-full border border-border bg-surface px-3 text-[12.5px] text-fg-subtle hover:text-fg"
        >
          ← 一覧
        </Link>
      </div>
      <div data-edit className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => { setDate(e.target.value); setSaved(false); }}
          className="h-10 rounded-card border border-border bg-surface px-3 text-[14px] outline-none focus:border-accent"
        />
        <input
          value={memo}
          onChange={(e) => { setMemo(e.target.value); setSaved(false); }}
          placeholder="メモ（会場・持ち時間など）"
          className="h-10 min-w-0 flex-1 basis-48 rounded-card border border-border bg-surface px-3 text-[14px] outline-none focus:border-accent"
        />
      </div>
      <p className="mt-2 text-[13px] text-fg-muted">
        {items.length}曲{fullSec > 0 && ` · 全長 ${minutesLabel(fullSec)}`}
        {noHop.size > 0 && <span className="text-warn">{` · 繋ぎなし ${noHop.size}か所`}</span>}
        {reversed.size > 0 && <span className="text-warn">{` · 時間が逆行 ${reversed.size}か所`}</span>}
        {sameSong.size > 0 && <span className="text-warn">{` · 同じ曲 ${sameSong.size}か所`}</span>}
      </p>

      {/* ── 並び ── */}
      <ol className="mt-3 space-y-1">
        {items.map((rb, i) => {
          const t = byRb.get(rb);
          const hop = i < hops.length ? hops[i] : undefined;
          const via = hop ? transitionById.get(hop) : undefined;
          const others = i + 1 < items.length
            ? transitions.filter((x) => x.fromTrackId === trackIds[i] && x.toTrackId === trackIds[i + 1])
            : [];
          const toCue = via ? cueLabel(cueById.get(via.toCueId)) : "";
          const bars = via ? barsLabel(via, toCue) : null;
          return (
            <li key={`${rb}-${i}`}>
              <div className="flex items-center gap-2 rounded-card border border-border bg-surface py-1.5 pl-2 pr-1.5">
                <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-subtle">{i + 1}</span>
                <span className="min-w-0 flex-1 break-words text-[15px]">
                  {t?.name ?? `rekordbox に無い曲（${rb}）`}
                  {sameSong.has(i) && (
                    <span className="ml-2 inline-block rounded border border-warn/40 px-1.5 text-[10.5px] text-warn">
                      {`${sameSong.get(i)! + 1}曲目と同じ曲`}
                    </span>
                  )}
                </span>
                <span data-edit className="flex shrink-0 gap-1">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className={btn} aria-label="上へ">↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === items.length - 1} className={btn} aria-label="下へ">↓</button>
                  <button onClick={() => remove(i)} className={btn} aria-label="外す">×</button>
                </span>
              </div>
              {i + 1 < items.length && (
                <div className="ml-8 border-l border-border py-1 pl-3 text-[12px]">
                  {via ? (
                    <span className="text-fg-subtle">
                      {cueLabel(cueById.get(via.fromCueId))} → {toCue}
                      {bars && ` · ${bars}`}
                    </span>
                  ) : (
                    <span className="text-warn">繋ぎが記録されていません（/play では「曲を変える」で移ります）</span>
                  )}
                  {reversed.has(i) && (
                    <span className="block text-warn">この曲に入った位置より前から抜けます（時間が逆行）</span>
                  )}
                  {others.length > 1 && (
                    <select
                      data-edit
                      value={hop ?? ""}
                      onChange={(e) => chooseHop(i, e.target.value)}
                      className="mt-1 block max-w-full rounded border border-border bg-surface px-1.5 py-1 text-[12px] text-fg-muted"
                    >
                      {others.map((x) => (
                        <option key={x.id} value={x.id}>
                          {`${cueLabel(cueById.get(x.fromCueId))} → ${cueLabel(cueById.get(x.toCueId))}${x.rating ? ` ${x.rating}` : ""}`}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {items.length === 0 && (
          <li className="px-1 py-3 text-[13px] text-fg-subtle">まだ曲がありません。下から足してください。</li>
        )}
      </ol>

      {/* ── 保存・/play・削除 ── */}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          data-edit
          onClick={save}
          disabled={!dirty || busy || !name.trim()}
          className="tap flex-1 rounded-card border border-accent/50 bg-accent/10 px-4 text-[14px] font-semibold text-accent disabled:opacity-40"
        >
          {busy ? "保存中…" : dirty ? "保存する" : "保存済み"}
        </button>
        {items.length > 0 && (
          <Link
            href={`/play?from=${encodeURIComponent(trackIds[0])}`}
            onClick={startPlay}
            className="tap flex flex-1 items-center justify-center rounded-card border border-hot/50 bg-hot/12 px-4 text-[14px] font-semibold text-hot"
          >
            この順で /play を始める →
          </Link>
        )}
      </div>
      {saved && !dirty && <p className="mt-2 text-[13px] text-fg-muted">保存しました。</p>}
      {error && <p className="mt-2 text-[13px] text-warn">{error}</p>}
      <p className="mt-2 text-[12px] text-fg-subtle">
        rekordbox へは PC で rekordbox を閉じてから <code className="font-mono">tools/rb_playlist.py --apply</code>
        （rekordbox の「rekord_graph」フォルダに同じ名前で作ります）。
      </p>

      {/* ── 曲を足す ── */}
      <section data-edit className="mt-5">
        <span className="label">曲を足す（最後に入ります）</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="曲を検索（別名でも可）"
          inputMode="search"
          autoComplete="off"
          className="mt-1.5 h-11 w-full rounded-card border border-border bg-surface px-4 text-[15px] outline-none placeholder:text-fg-subtle focus:border-accent"
        />
        {!q.trim() && lastId && (
          <p className="mt-2 text-[12px] text-fg-subtle">最後の曲から繋ぎが記録されている曲:</p>
        )}
        <ul className="mt-1.5 space-y-1">
          {suggestions.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => add(t)}
                className="tap flex w-full items-center gap-2 rounded-card border border-border bg-surface px-3 py-1.5 text-left hover:border-border-bright"
              >
                <span className="min-w-0 flex-1 break-words text-[14px]">{t.name}</span>
                {usedSongs.has(t.songId) && <span className="shrink-0 text-[11px] text-warn">入っています</span>}
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">{t.bpm ?? "–"}</span>
                <span className="shrink-0 text-[13px] text-accent">＋</span>
              </button>
            </li>
          ))}
          {q.trim() && suggestions.length === 0 && (
            <li className="px-1 py-2 text-[13px] text-fg-subtle">見つかりません</li>
          )}
        </ul>
      </section>

      {/* ── 削除（2タップ） ── */}
      <div data-edit className="mt-8 border-t border-border pt-3">
        {confirmDelete ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-warn">「{playlist.name}」を削除しますか？（Notion のゴミ箱から戻せます）</span>
            <button onClick={destroy} disabled={busy} className="tap rounded-full border border-warn/50 px-3 text-warn">削除する</button>
            <button onClick={() => setConfirmDelete(false)} className="tap rounded-full border border-border px-3 text-fg-muted">やめる</button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="tap text-[12.5px] text-fg-subtle hover:text-warn">
            このプレイリストを削除
          </button>
        )}
      </div>
    </main>
  );
}
