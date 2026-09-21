import Link from "next/link";
import { CuePad, LoopTag } from "@/components/CuePad";
import { showsLoop } from "@/lib/format";
import { getGraph, type Cue, type Graph, type Transition } from "@/lib/graph";

export const metadata = { title: "チェーン | rekord_graph" };

/**
 * チェーン = 実際に回した流れの記録（移行元の「完全版」の連番）。
 * グラフ/ツリーが「可能性」を見る画面なのに対し、ここは「実績」を読み返す画面。
 *
 * 1本のチェーンには分岐が混ざっていることがある（例: ドーナツホールから
 * 転生林檎にもローリンガールにも行った）。直列リストに挟むと線として
 * 読めなくなるので、最長の連続再生を主線として選び、残りは分岐として添える。
 */
/** チェーン名が空の繋ぎ（入力画面の「チェーン」欄を空のまま保存したもの）の寄せ集め */
const UNSORTED = "（未分類）";

/**
 * 主線探しの打ち切り（試した繋ぎの数）。名前の付いたチェーンは数本〜十数本なので
 * 実データでは届かない。届いたら、それまでに見つけた最長で止める（止まらない画面よりまし）
 */
const MAX_STEPS = 20_000;

function orderChain(list: Transition[]): { main: Transition[]; branches: Transition[] } {
  const sorted = [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  let steps = 0;
  const longestFrom = (track: string, used: Set<string>): Transition[] => {
    let best: Transition[] = [];
    for (const t of sorted) {
      if (used.has(t.id) || t.fromTrackId !== track) continue;
      if (++steps > MAX_STEPS) break;
      used.add(t.id);
      const rest = longestFrom(t.toTrackId, used);
      if (1 + rest.length > best.length) best = [t, ...rest];
      used.delete(t.id);
    }
    return best;
  };

  // 起点 = チェーン内でどの曲からも入ってこない曲。無ければ記録順の先頭
  const toSet = new Set(sorted.map((t) => t.toTrackId));
  const starts = [...new Set(sorted.map((t) => t.fromTrackId))].filter((f) => !toSet.has(f));
  let main: Transition[] = [];
  for (const s of starts.length ? starts : sorted.slice(0, 1).map((t) => t.fromTrackId)) {
    const walk = longestFrom(s, new Set());
    if (walk.length > main.length) main = walk;
  }
  const mainIds = new Set(main.map((t) => t.id));
  return { main, branches: sorted.filter((t) => !mainIds.has(t.id)) };
}

function chainTitle(g: Graph, main: Transition[]): string {
  if (main.length === 0) return "";
  const names = [
    ...main.map((t) => g.trackById.get(t.fromTrackId)?.name ?? "?"),
    g.trackById.get(main[main.length - 1].toTrackId)?.name ?? "?",
  ];
  return names.join(" → ");
}

/** 曲名の後ろに添える BPM。曲名の一部として折り返させたいので inline で置く */
const Bpm = ({ value }: { value: number | null }) => (
  <span className="ml-1.5 whitespace-nowrap font-mono text-[11px] tabular-nums text-fg-subtle">
    {value ?? "–"}
    <span className="ml-0.5 text-[9px] tracking-wide">BPM</span>
  </span>
);

/**
 * キュー1つ = パッド＋キュー名。ループの札はキュー名の**すぐ後ろ**に置く
 * （列の端へ離すと、どのキューの札なのかが読めない）。
 * キュー名は刈らない（キュー名が正。`助走 1サビ…` では別のキューと見分けられない）。長ければ折り返す
 */
function CueCell({ cue }: { cue: Cue | undefined }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <CuePad cue={cue} size="sm" />
      <span className="min-w-0 break-words text-[13px] text-fg-muted">
        {cue?.name}
        {cue && showsLoop(cue) && <>{" "}<LoopTag cue={cue} /></>}
      </span>
    </span>
  );
}

function Row({ g, t, branch }: { g: Graph; t: Transition; branch?: boolean }) {
  const from = g.trackById.get(t.fromTrackId);
  const to = g.trackById.get(t.toTrackId);
  return (
    <li className={branch ? "border-l-2 border-dashed border-hot/40 bg-hot/[0.03] p-3 pl-4" : "p-3"}>
      {branch && (
        <span className="mb-1.5 inline-block rounded border border-hot/35 px-1.5 py-0.5 text-[10px] tracking-wide text-hot">
          分岐
        </span>
      )}
      {/*
        曲名の行とキューの行を同じ3列（From | → | To）に載せる。別々の行で並べていたときは、
        曲名の長さで「→」の位置が行ごとにずれ、どの曲のどのキューかが読みにくかった
      */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
        {/* 曲名には BPM を添える。流れを読み返すとき、どこでテンポが動いたかが要る */}
        <Link href={`/track/${t.fromTrackId}`} className="min-w-0 break-words text-[15px] hover:text-accent">
          {from?.name ?? "?"}
          <Bpm value={from?.bpm ?? null} />
        </Link>
        <span className="text-fg-subtle">→</span>
        <Link href={`/track/${t.toTrackId}`} className="min-w-0 break-words text-[15px] hover:text-accent">
          {to?.name ?? "?"}
          <Bpm value={to?.bpm ?? null} />
        </Link>
        <CueCell cue={g.cueById.get(t.fromCueId)} />
        <span className="text-[12px] text-fg-subtle">→</span>
        <CueCell cue={g.cueById.get(t.toCueId)} />
      </div>
      {t.comment && <p className="mt-1.5 break-words text-[13px] text-fg-subtle">{t.comment}</p>}
    </li>
  );
}

export default async function ChainPage() {
  const g = await getGraph();

  const byChain = new Map<string, Transition[]>();
  for (const t of g.transitions) {
    const key = t.chain || UNSORTED;
    (byChain.get(key) ?? byChain.set(key, []).get(key)!).push(t);
  }

  return (
    <main className="relative z-1 mx-auto max-w-6xl px-4 pb-nav lg:px-8">
      <header className="sticky top-0 z-20 -mx-4 border-b border-border bg-bg/85 px-4 pb-3 pt-4 backdrop-blur-md lg:-mx-8 lg:px-8">
        <h1 className="text-[26px] font-bold leading-none tracking-tight">チェーン</h1>
        <p className="mt-1.5 text-[13px] text-fg-muted">
          実際に回した流れの記録。枝分かれした繋ぎは「分岐」として添えてあります
        </p>
      </header>

      <div className="mt-6 gap-6 md:columns-2 2xl:columns-3">
        {[...byChain.entries()]
          .sort(([a], [b]) => a.localeCompare(b, "ja", { numeric: true }))
          .map(([name, list], ci) => {
            /*
              未分類はチェーンではない（名前の無い繋ぎの寄せ集め）ので、主線を探さず新しい順に並べる。
              探すと、入力画面から入れた繋ぎ（チェーン欄は空が既定）が増えるほど探索が爆発する
              （実測: 114本でページ1枚に約50秒。静的生成の上限 60秒に迫っていた）
            */
            const unsorted = name === UNSORTED;
            const { main, branches } = unsorted
              ? { main: [...list].sort((a, b) => b.createdTime.localeCompare(a.createdTime)), branches: [] }
              : orderChain(list);
            return (
              // 未分類（100本超）は段をまたいで流す。1段に押し込むと、PC では隣の段が
              // 1万px 以上空いたままになっていた
              <section key={name} className={`mb-6 rise ${unsorted ? "" : "break-inside-avoid"}`} style={{ animationDelay: `${ci * 50}ms` }}>
                <h2 className="label mb-1">{name.replace(/^chain/i, "チェーン ")} · {list.length}本</h2>
                <p className="mb-2 break-words text-[12.5px] text-fg-muted" title={unsorted ? undefined : chainTitle(g, main)}>
                  {unsorted ? "チェーン名の無い繋ぎ（新しい順）" : chainTitle(g, main)}
                </p>
                <ol className="rounded-card border border-border bg-surface divide-y divide-border">
                  {main.map((t) => <Row key={t.id} g={g} t={t} />)}
                  {branches.map((t) => <Row key={t.id} g={g} t={t} branch />)}
                </ol>
              </section>
            );
          })}
      </div>

      {byChain.size === 0 && (
        <p className="mt-8 rounded-card border border-dashed border-border p-8 text-center text-fg-subtle">
          まだ記録がありません
        </p>
      )}
    </main>
  );
}
