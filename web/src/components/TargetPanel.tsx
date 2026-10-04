"use client";

import { NO_TARGET, type SetTarget } from "@/lib/setTarget";

/**
 * 長さ指定（何曲・何分のセットにしたいか）の設定。/play の最初の曲を選ぶ一覧に出す。
 * 時間は**繋いで流したら何分か**（カット後）。よく使う枠はボタンで、細かい数は欄で入れる。
 * 空の欄はその側を縛らない。
 */
const PRESETS: { label: string; t: SetTarget }[] = [
  { label: "〜30分", t: { ...NO_TARGET, maxMinutes: 30 } },
  { label: "30〜45分", t: { ...NO_TARGET, minMinutes: 30, maxMinutes: 45 } },
  { label: "45〜60分", t: { ...NO_TARGET, minMinutes: 45, maxMinutes: 60 } },
  { label: "60〜90分", t: { ...NO_TARGET, minMinutes: 60, maxMinutes: 90 } },
];

const same = (a: SetTarget, b: SetTarget) =>
  a.minSongs === b.minSongs && a.maxSongs === b.maxSongs &&
  a.minMinutes === b.minMinutes && a.maxMinutes === b.maxMinutes;

export function TargetPanel({
  target, onChange, onClose,
}: {
  target: SetTarget;
  onChange: (t: SetTarget) => void;
  onClose: () => void;
}) {
  const chip = (on: boolean) =>
    `btn px-3.5 text-[13px] ${on ? "btn-accent" : ""}`;
  const field = (key: keyof SetTarget, placeholder: string) => (
    <input
      type="number"
      inputMode="numeric"
      min={1}
      value={target[key] ?? ""}
      placeholder={placeholder}
      onChange={(e) => {
        const n = e.target.value === "" ? null : Math.max(1, Math.round(Number(e.target.value)));
        onChange({ ...target, [key]: Number.isFinite(n) ? n : null });
      }}
      className="h-11 w-16 rounded-pad border border-border bg-bg-deep px-2 text-center font-mono text-[16px] tabular-nums outline-none placeholder:text-fg-subtle focus:border-accent"
    />
  );

  return (
    <section className="mt-3 space-y-3 rounded-card border border-border bg-surface p-3">
      <div>
        <span className="label">時間 · 繋いで流したら何分か</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => onChange(p.t)} className={chip(same(target, p.t))}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2 text-[13px] text-fg-muted">
          {field("minMinutes", "下限")}<span>〜</span>{field("maxMinutes", "上限")}<span>分</span>
        </div>
      </div>
      <div>
        <span className="label">曲数</span>
        <div className="mt-1.5 flex items-center gap-2 text-[13px] text-fg-muted">
          {field("minSongs", "下限")}<span>〜</span>{field("maxSongs", "上限")}<span>曲</span>
        </div>
      </div>
      <p className="text-[12px] leading-relaxed text-fg-subtle">
        各曲の一番長い道筋を、この枠に収まるところで切って出します。収まらない曲は一覧から外します。
      </p>
      <div className="flex justify-end gap-2">
        <button onClick={() => onChange(NO_TARGET)} className={chip(false)}>指定しない</button>
        <button onClick={onClose} className={chip(false)}>閉じる</button>
      </div>
    </section>
  );
}
