import { DIFFICULTIES } from "@/lib/difficulty";
import type { SkipChoice, TagGroup } from "@/lib/playFilter";
import { NO_FILTER, type PlayFilter } from "@/lib/playlog";
import { RATINGS } from "@/lib/ratings";

/**
 * 除外条件の設定。`/play` と入力画面（登録済み一覧）で同じものを出す。
 * 条件は端末に1つだけ（`lib/playlog.ts`）なので、どちらで変えても両方に効く。
 *どちらも「ここまで使う」の1軸なので、以上/以下を読ませずに
 * 選択肢そのものに言い切らせる（「全部」「Middle まで」「Easy だけ」）。
 * 未入力の繋ぎはどの条件でも外さない。
 */
export function FilterPanel({
  filter, genres, tagGroups, onChange, onClose,
}: {
  filter: PlayFilter;
  /** 選べるジャンル（`genreKey` で束ねたもの）と、それを行き先に持つ曲の数 */
  genres: SkipChoice[];
  /** My Tag のカテゴリごとの選択肢（`原曲` → アニメ・VOCALOID…） */
  tagGroups: TagGroup[];
  onChange: (f: PlayFilter) => void;
  onClose: () => void;
}) {
  const chip = (on: boolean) =>
    `tap rounded-full border px-3.5 text-[13px] transition-colors ${
      on ? "border-accent/60 bg-accent/12 text-accent" : "border-border bg-surface text-fg-muted hover:text-fg"
    }`;
  const difficultyChoices: { value: string | null; label: string }[] = [
    { value: null, label: "全部" },
    ...DIFFICULTIES.slice(0, -1).reverse().map((d, i, arr) => ({
      value: d,
      label: i === arr.length - 1 ? `${d} だけ` : `${d} まで`,
    })),
  ];
  const starChoices = [0, ...RATINGS.slice(1).map((_, i) => i + 2)];

  return (
    <section className="mt-3 space-y-3 rounded-card border border-border bg-surface p-3">
      <div>
        <span className="label">難易度 · 難しい繋ぎを外す</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {difficultyChoices.map((c) => (
            <button
              key={c.label}
              onClick={() => onChange({ ...filter, maxDifficulty: c.value })}
              className={chip(filter.maxDifficulty === c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="label">評価 · 星の少ない繋ぎを外す</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {starChoices.map((n) => (
            <button
              key={n}
              onClick={() => onChange({ ...filter, minStars: n })}
              className={chip(filter.minStars === n)}
            >
              {n === 0 ? "全部" : `${"★".repeat(n)} 以上`}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="label">要練習</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <button
            onClick={() => onChange({ ...filter, skipPractice: !filter.skipPractice })}
            aria-pressed={filter.skipPractice}
            className={chip(filter.skipPractice)}
          >
            {filter.skipPractice ? "要練習の繋ぎを外す" : "要練習の繋ぎも出す"}
          </button>
        </div>
      </div>
      {genres.length > 0 && (
        <div>
          <span className="label">ジャンル · 押したジャンルの曲へは繋がない</span>
          <SkipChips
            items={genres}
            skipped={filter.skipGenres}
            onChange={(skipGenres) => onChange({ ...filter, skipGenres })}
          />
        </div>
      )}
      {/* My Tag（rekordbox）。原曲の分類などカテゴリごとに並べる */}
      {tagGroups.map((g) => (
        <div key={g.category}>
          <span className="label">{g.category} · 押したタグの曲へは繋がない</span>
          <SkipChips
            items={g.tags}
            skipped={filter.skipTags}
            onChange={(skipTags) => onChange({ ...filter, skipTags })}
          />
        </div>
      ))}
      <p className="text-[12px] leading-snug text-fg-subtle">
        難易度・評価・ジャンル・タグが未入力のものは外しません。条件はこの端末に残り、リセットしても消えません。
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => onChange(NO_FILTER)}
          className="tap flex-1 rounded-card border border-border px-4 text-[13px] text-fg-muted hover:text-fg"
        >
          条件を外す
        </button>
        <button
          onClick={onClose}
          className="tap flex-1 rounded-card border border-border bg-surface-2 px-4 text-[13px] text-fg hover:border-border-bright"
        >
          閉じる
        </button>
      </div>
    </section>
  );
}

/** 押すと「外す」に切り替わるチップの列。ジャンルと My Tag で同じ形を使う */
function SkipChips({
  items, skipped, onChange,
}: {
  items: SkipChoice[];
  skipped: string[];
  onChange: (skipped: string[]) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {items.map((g) => {
        const off = skipped.includes(g.key);
        return (
          <button
            key={g.key}
            onClick={() => onChange(off ? skipped.filter((k) => k !== g.key) : [...skipped, g.key])}
            aria-pressed={off}
            className={`tap rounded-full border px-3 text-[13px] transition-colors ${
              off
                ? "border-warn/60 bg-warn/12 text-warn line-through"
                : "border-border bg-surface text-fg-muted hover:text-fg"
            }`}
          >
            {g.label}
            <span className="ml-1 font-mono text-[11px] tabular-nums opacity-70">{g.count}</span>
          </button>
        );
      })}
    </div>
  );
}
