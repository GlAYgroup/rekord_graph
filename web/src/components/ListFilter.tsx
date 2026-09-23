import { DIFFICULTIES } from "@/lib/difficulty";
import { RATINGS, starCount } from "@/lib/ratings";

/**
 * 入力画面（`/new`）の登録済み一覧の**絞り込み**。
 *
 * `/play` の除外条件（「Middle まで」「★★★以上」= 以上・以下で切る）とは別物。こちらは
 * 「Middle だけ」「★★★だけ」と**押した値そのものに一致する繋ぎだけ**を出す（入れた値を
 * 見直す場所なので、段階ごとに眺めたい）。同じ段の中は複数押せて「どれか」、段どうしは「全部」。
 * 何も押していない段は絞らない。「未入力」も1つの値として押せる（まだ付けていない繋ぎを探すため）。
 * 条件はこの画面の中だけで持ち、`/play` には効かせない。
 */
export type ListFilter = {
  /** `lib/difficulty.ts` の値。"" = 未入力 */
  difficulties: string[];
  /** 星の数。0 = 未評価 */
  stars: number[];
  /** 要練習の印。null = 絞らない */
  practice: boolean | null;
  /** 行き先の曲の My Tag（`原曲/VOCALOID`）。どれかが付いている繋ぎだけ */
  tags: string[];
};

export const NO_LIST_FILTER: ListFilter = { difficulties: [], stars: [], practice: null, tags: [] };

type Row = { difficulty: string | null; rating: string | null; practice: boolean; toMyTags: string[] };

export const isListFiltering = (f: ListFilter) =>
  f.difficulties.length > 0 || f.stars.length > 0 || f.practice !== null || f.tags.length > 0;

export function matchesListFilter(f: ListFilter, r: Row): boolean {
  if (f.difficulties.length > 0 && !f.difficulties.includes(r.difficulty ?? "")) return false;
  if (f.stars.length > 0 && !f.stars.includes(starCount(r.rating))) return false;
  if (f.practice !== null && r.practice !== f.practice) return false;
  if (f.tags.length > 0 && !r.toMyTags.some((t) => f.tags.includes(t))) return false;
  return true;
}

/** ボタンに出す短い言い方。`Middle・★★★・VOCALOID` */
export function listFilterSummary(f: ListFilter): string {
  const parts: string[] = [];
  if (f.difficulties.length > 0) parts.push(f.difficulties.map((d) => d || "難易度なし").join("/"));
  if (f.stars.length > 0) parts.push(f.stars.map((n) => (n ? "★".repeat(n) : "星なし")).join("/"));
  if (f.practice !== null) parts.push(f.practice ? "要練習" : "要練習なし");
  if (f.tags.length > 0) parts.push(f.tags.map((t) => t.slice(t.indexOf("/") + 1)).join("/"));
  return parts.join("・");
}

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export function ListFilterPanel({
  filter, rows, onChange, onClose,
}: {
  filter: ListFilter;
  /** 各ボタンの横に「その値の繋ぎが何本あるか」を出すため（全件で数える） */
  rows: readonly Row[];
  onChange: (f: ListFilter) => void;
  onClose: () => void;
}) {
  const chip = (on: boolean) =>
    `tap rounded-full border px-3.5 text-[13px] transition-colors ${
      on ? "border-accent/60 bg-accent/12 text-accent" : "border-border bg-surface text-fg-muted hover:text-fg"
    }`;
  const n = (pred: (r: Row) => boolean) => (
    <span className="ml-1 font-mono text-[11px] tabular-nums opacity-70">{rows.filter(pred).length}</span>
  );
  // 行き先の曲に付いている My Tag。カテゴリごとに、多い順
  const tagGroups = new Map<string, Map<string, number>>();
  for (const r of rows) {
    for (const t of r.toMyTags) {
      const cat = t.slice(0, t.indexOf("/"));
      const m = tagGroups.get(cat) ?? tagGroups.set(cat, new Map()).get(cat)!;
      m.set(t, (m.get(t) ?? 0) + 1);
    }
  }

  return (
    <section className="mt-3 space-y-3 rounded-card border border-border bg-surface p-3">
      <div>
        <span className="label">難易度 · 押したものだけ</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {[...DIFFICULTIES, ""].map((d) => (
            <button
              key={d || "none"}
              type="button"
              onClick={() => onChange({ ...filter, difficulties: toggle(filter.difficulties, d) })}
              aria-pressed={filter.difficulties.includes(d)}
              className={chip(filter.difficulties.includes(d))}
            >
              {d || "未入力"}
              {n((r) => (r.difficulty ?? "") === d)}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="label">評価 · 押したものだけ</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {[...RATINGS.map((_, i) => i + 1), 0].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange({ ...filter, stars: toggle(filter.stars, s) })}
              aria-pressed={filter.stars.includes(s)}
              className={chip(filter.stars.includes(s))}
            >
              {s ? "★".repeat(s) : "未評価"}
              {n((r) => starCount(r.rating) === s)}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="label">要練習</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {([null, true, false] as const).map((p) => (
            <button
              key={String(p)}
              type="button"
              onClick={() => onChange({ ...filter, practice: p })}
              aria-pressed={filter.practice === p}
              className={chip(filter.practice === p)}
            >
              {p === null ? "全部" : p ? "要練習だけ" : "要練習でないものだけ"}
              {p !== null && n((r) => r.practice === p)}
            </button>
          ))}
        </div>
      </div>
      {[...tagGroups].sort((a, b) => a[0].localeCompare(b[0], "ja")).map(([cat, tags]) => (
        <div key={cat}>
          <span className="label">{cat} · 行き先の曲がこのタグのものだけ</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {[...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja")).map(([tag, count]) => (
              <button
                key={tag}
                type="button"
                onClick={() => onChange({ ...filter, tags: toggle(filter.tags, tag) })}
                aria-pressed={filter.tags.includes(tag)}
                className={chip(filter.tags.includes(tag))}
              >
                {tag.slice(tag.indexOf("/") + 1)}
                <span className="ml-1 font-mono text-[11px] tabular-nums opacity-70">{count}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <p className="text-[12px] leading-snug text-fg-subtle">
        同じ段で複数押すと「どれか」、段をまたぐと「全部」に当てはまる繋ぎを出します。プレイ画面の除外条件とは別です。
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onChange(NO_LIST_FILTER)}
          className="tap flex-1 rounded-card border border-border px-4 text-[13px] text-fg-muted hover:text-fg"
        >
          絞り込みを外す
        </button>
        <button
          type="button"
          onClick={onClose}
          className="tap flex-1 rounded-card border border-border bg-surface-2 px-4 text-[13px] text-fg hover:border-border-bright"
        >
          閉じる
        </button>
      </div>
    </section>
  );
}
