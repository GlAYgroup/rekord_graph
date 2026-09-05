"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CARD_H, CARD_W, type TreeData } from "@/lib/tree";

/**
 * MixTree 風のツリー表示。起点の曲を左端に置き、右へ分岐していく。
 * レイアウトはサーバで計算済み（決定的）。ここはパン/ズームと選択だけ。
 */

type Transform = { x: number; y: number; k: number };

/** 全角=1・半角=0.6 で数えて幅に収める。SVG text は overflow を刈ってくれないため。
    半角を 0.5 で数えると英字主体の曲名が枠線まで達する（実測 0.6 文字分。tree.ts の折り返しと同じ係数） */
function clipText(text: string, maxUnits: number): string {
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    units += text.charCodeAt(i) > 0xff ? 1 : 0.6;
    if (units > maxUnits) return `${text.slice(0, i)}…`;
  }
  return text;
}

export type RootOption = { id: string; name: string; maxFrom: number };

export function TreeMixView({
  tree, rootName, rootOptions,
}: {
  tree: TreeData;
  rootName: string;
  rootOptions: RootOption[];
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const [selected, setSelected] = useState<string | null>(null); // trackId（同じ曲の全カードが光る）
  const [rootQ, setRootQ] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const rootMatches = rootQ.trim()
    ? rootOptions.filter((o) => o.name.toLowerCase().includes(rootQ.trim().toLowerCase()))
    : rootOptions;

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const movedRef = useRef(0);
  /**
   * pointerdown したカード。選択は container の pointerup で確定する。
   * onClick に頼ると setPointerCapture(svg) が click を svg に奪ってしまい、
   * カードのクリックが一切効かない（レビューで実機再現済み）。
   */
  const pressedCardRef = useRef<string | null>(null);
  const cardByUid = new Map(tree.cards.map((c) => [c.uid, c]));

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const pad = 60;
    const fitK = Math.min((w - pad) / tree.width, (h - pad) / tree.height, 1.1);
    const k = Math.max(0.15, fitK);
    if (k === fitK) {
      setTransform({ k, x: (w - tree.width * k) / 2, y: (h - tree.height * k) / 2 });
      return;
    }
    // 最小ズームでも収まらない（スマホ）。中央寄せだと起点が見切れるので、
    // 起点を左端に見せて右へパンで辿る（ネットワーク図の「読める一部を出す」と同じ思想）
    const root = tree.cards.find((c) => c.depth === 0);
    const cy = root ? root.y + CARD_H / 2 : tree.height / 2;
    setTransform({ k, x: pad / 2, y: h / 2 - cy * k });
  }, [tree]);
  const fitRef = useRef(fit);
  fitRef.current = fit;

  useEffect(() => { fitRef.current(); }, [fit]);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let last = { w: 0, h: 0 };
    const ro = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry.contentRect;
      if (Math.abs(w - last.w) < 2 && Math.abs(h - last.h) < 2) return;
      last = { w, h };
      fitRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = localPoint(e);
      setTransform((t) => {
        const k = Math.min(2.5, Math.max(0.15, t.k * Math.exp(-e.deltaY * 0.0016)));
        return { k, x: p.x - ((p.x - t.x) / t.k) * k, y: p.y - ((p.y - t.y) / t.k) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // パンとピンチ（増分方式。グラフ画面と同じ作法）
  const onPointerDown = (e: React.PointerEvent) => {
    setPickerOpen(false);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, localPoint(e));
    if (pointers.current.size === 1) movedRef.current = 0;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = localPoint(e);
    const prev = pointers.current.get(e.pointerId)!;
    pointers.current.set(e.pointerId, p);
    movedRef.current += Math.hypot(p.x - prev.x, p.y - prev.y);

    if (pointers.current.size >= 2) {
      const others = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId);
      const o = others[0][1];
      const prevMid = { x: (prev.x + o.x) / 2, y: (prev.y + o.y) / 2 };
      const curMid = { x: (p.x + o.x) / 2, y: (p.y + o.y) / 2 };
      const prevDist = Math.max(1, Math.hypot(prev.x - o.x, prev.y - o.y));
      const curDist = Math.max(1, Math.hypot(p.x - o.x, p.y - o.y));
      setTransform((t) => {
        const k = Math.min(2.5, Math.max(0.15, t.k * (curDist / prevDist)));
        return {
          k,
          x: curMid.x - ((prevMid.x - t.x) / t.k) * k,
          y: curMid.y - ((prevMid.y - t.y) / t.k) * k,
        };
      });
    } else {
      setTransform((t) => ({ ...t, x: t.x + (p.x - prev.x), y: t.y + (p.y - prev.y) }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      if (movedRef.current < 6) {
        const id = pressedCardRef.current;
        setSelected((cur) => (id ? (cur === id ? null : id) : null)); // 背景タップは閉じる
      }
      pressedCardRef.current = null;
    }
  };

  const sel = selected ? tree.cards.find((c) => c.trackId === selected) : null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-x-0 top-0 bottom-[var(--nav-h)] touch-none select-none overflow-hidden bg-bg-deep md:bottom-0 md:left-16"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        aria-label={`${rootName} を起点にしたツリー`}
      >
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {tree.links.map((l) => {
            const a = cardByUid.get(l.from);
            const b = cardByUid.get(l.to);
            if (!a || !b) return null;
            const x1 = a.x + CARD_W, y1 = a.y + CARD_H / 2;
            const x2 = b.x, y2 = b.y + CARD_H / 2;
            const mid = (x2 - x1) / 2;
            // ベジェは t=0.5 でちょうど両端の中点を通る。ラベルはそこに置く
            const lx = (x1 + x2) / 2, ly = (y1 + y2) / 2;
            return (
              <g key={l.id}>
                <path
                  d={`M${x1},${y1} C${x1 + mid},${y1} ${x2 - mid},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke={l.onRoute ? "var(--hot)" : "var(--border-bright)"}
                  strokeWidth={l.onRoute ? 2.2 : 1.4}
                  strokeOpacity={l.onRoute ? 0.95 : 0.6}
                />
                {/* どのキューからどのキューへ繋ぐかは線の上に出す（カードには置かない）。
                    From→ と To の2行で線を挟み、背景色の縁取りで線と重なっても読めるようにする。
                    列間はこのラベルの最大幅に合わせてサーバが広げている（tree.ts） */}
                {b.via && (
                  <g
                    textAnchor="middle"
                    fontSize="10.5"
                    style={{ fontFamily: "var(--font-mono)" }}
                    fill={l.onRoute ? "var(--fg)" : "var(--fg-muted)"}
                    stroke="var(--bg-deep)"
                    strokeWidth="4"
                    strokeLinejoin="round"
                    paintOrder="stroke"
                  >
                    <text x={lx} y={ly - 4}>{`${b.via.fromCue}→`}</text>
                    <text x={lx} y={ly + 12}>{b.via.toCue}</text>
                  </g>
                )}
              </g>
            );
          })}
          {tree.cards.map((c) => {
            const isSel = selected === c.trackId;
            const isRoot = c.depth === 0;
            return (
              <g
                key={c.uid}
                transform={`translate(${c.x},${c.y})`}
                className="cursor-pointer"
                role="button"
                tabIndex={0}
                aria-label={`${c.name} を選択`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected((cur) => (cur === c.trackId ? null : c.trackId));
                  }
                }}
                onPointerDown={() => { pressedCardRef.current = c.trackId; }}
              >
                {/* 子は単一文字列にする。複数の子だと React が <title> を特別扱いして hydration がズレる */}
                <title>{`${c.name}${c.via ? `\n${c.via.fromCue} → ${c.via.toCue}` : ""}`}</title>
                <rect
                  width={CARD_W} height={CARD_H} rx="12"
                  fill={c.onRoute ? "color-mix(in srgb, var(--hot) 10%, var(--surface))" : "var(--surface)"}
                  stroke={isSel ? "var(--accent)" : isRoot ? "var(--accent-deep)" : c.onRoute ? "var(--hot)" : "var(--border-bright)"}
                  strokeWidth={isSel || isRoot ? 1.8 : 1.1}
                />
                {/* 曲名は1行目を丸ごと使い、カード幅で刈る（はみ出すと隣のカードに重なって読めない）。
                    全文は <title>（長押し/ホバー）と選択パネルで読める。繋ぎのキューは線上にある */}
                <text x="12" y="21" fill="var(--fg)" fontSize="13" fontWeight="600" style={{ fontFamily: "var(--font-sans)" }}>
                  {clipText(c.name, 12)}
                </text>
                <text x="12" y="40" fontSize="10" style={{ fontFamily: "var(--font-sans)" }}>
                  {isRoot && <tspan fill="var(--accent)">起点 · </tspan>}
                  <tspan fill={c.maxFrom > 1 ? "var(--hot)" : "var(--fg-subtle)"}>
                    {c.maxFrom > 1 ? `この先 最大${c.maxFrom}曲` : "行き止まり"}
                  </tspan>
                </text>
                <text x={CARD_W - 12} y="40" textAnchor="end" fill="var(--fg-subtle)" fontSize="10.5" style={{ fontFamily: "var(--font-mono)" }}>
                  {c.bpm ?? "–"}{c.musicalKey ? ` ${c.musicalKey}` : ""}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* ── 左上: モード切替 + 起点ピッカー ── */}
      <div className="absolute left-3 top-3 flex w-[min(280px,calc(100%-24px))] flex-col gap-2">
        <div className="flex gap-1.5">
          <Link
            href={`/graph?from=${tree.rootId}`}
            className="tap flex items-center rounded-full border border-border bg-surface/90 px-4 text-[12px] text-fg-muted backdrop-blur hover:text-fg"
          >
            ネットワーク
          </Link>
          <span className="tap flex items-center rounded-full border border-hot/60 bg-hot/15 px-4 text-[12px] text-hot backdrop-blur">
            ツリー
          </span>
        </div>
        <div className="relative">
          <input
            value={rootQ}
            onChange={(e) => { setRootQ(e.target.value); setPickerOpen(true); }}
            onFocus={() => setPickerOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && rootMatches[0]) {
                setPickerOpen(false);
                router.push(`/graph?mode=tree&root=${rootMatches[0].id}`);
              }
              if (e.key === "Escape") setPickerOpen(false);
            }}
            placeholder={`起点: ${rootName}`}
            aria-label="ツリーの起点を選ぶ"
            className="h-12 w-full rounded-card border border-border bg-surface/90 px-3.5 text-[16px] outline-none backdrop-blur placeholder:text-fg-muted focus:border-hot"
          />
          {pickerOpen && (
            <ul className="absolute inset-x-0 top-[52px] z-10 max-h-72 overflow-y-auto rounded-card border border-border bg-surface/95 shadow-lg backdrop-blur-md">
              {rootMatches.map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/graph?mode=tree&root=${o.id}`}
                    onClick={() => { setPickerOpen(false); setRootQ(""); }}
                    className={`tap flex items-center gap-2 px-3.5 text-[14px] hover:bg-elevated ${o.id === tree.rootId ? "text-hot" : ""}`}
                  >
                    <span className="min-w-0 flex-1 break-words">{o.name}</span>
                    <span className={`shrink-0 font-mono text-[11px] tabular-nums ${o.maxFrom > 1 ? "text-hot" : "text-fg-subtle"}`}>
                      {o.maxFrom > 1 ? `最大${o.maxFrom}曲` : "行き止まり"}
                    </span>
                  </Link>
                </li>
              ))}
              {rootMatches.length === 0 && (
                <li className="px-3.5 py-3 text-[13px] text-fg-subtle">見つかりません</li>
              )}
            </ul>
          )}
        </div>
        {tree.truncated && (
          <p className="rounded-card border border-border bg-surface/90 px-3.5 py-2 text-[12.5px] text-warn backdrop-blur">
            大きすぎるため一部を省略しています
          </p>
        )}
      </div>

      {/* ── 右上: 統計 ── */}
      <div className="absolute right-3 top-3 hidden gap-2 sm:flex">
        {[[tree.cards.length, "経路ノード"], [tree.cards.filter((c) => c.maxFrom === 1).length, "行き止まり"]].map(([v, l]) => (
          <div key={l} className="rounded-card border border-border bg-surface/90 px-3 py-1.5 text-center backdrop-blur">
            <span className="font-mono text-[16px] tabular-nums leading-none">{v}</span>
            <span className="label ml-1.5">{l}</span>
          </div>
        ))}
      </div>

      {/* ── 右下: ズーム ── */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1.5">
        {([["+", 1.35], ["−", 1 / 1.35], ["⊡", 0]] as const).map(([label, f]) => (
          <button
            key={label}
            onClick={() => {
              if (f === 0) { fit(); return; }
              const el = containerRef.current!;
              const { width: w, height: h } = el.getBoundingClientRect();
              const p = { x: w / 2, y: h / 2 };
              setTransform((t) => {
                const k = Math.min(2.5, Math.max(0.15, t.k * f));
                return { k, x: p.x - ((p.x - t.x) / t.k) * k, y: p.y - ((p.y - t.y) / t.k) * k };
              });
            }}
            className="tap grid size-11 place-items-center rounded-card border border-border bg-surface/90 font-mono text-[16px] text-fg-muted backdrop-blur hover:text-fg"
            aria-label={f === 0 ? "全体を表示" : f > 1 ? "拡大" : "縮小"}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── 選択パネル ── */}
      {sel && (
        <aside className="absolute inset-x-0 bottom-0 max-h-[46%] overflow-y-auto rounded-t-2xl border-t border-border bg-surface/95 p-4 backdrop-blur-md md:inset-x-auto md:bottom-auto md:right-3 md:top-16 md:max-h-[calc(100%-110px)] md:w-[300px] md:rounded-card md:border">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-[17px] font-bold leading-tight break-words">{sel.name}</h2>
              <p className="mt-0.5 font-mono text-[12px] tabular-nums text-fg-muted">
                {sel.bpm ?? "–"} BPM{sel.musicalKey && ` · ${sel.musicalKey}`}
                <span className="text-hot"> · 最大{sel.maxFrom}曲</span>
              </p>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="tap -m-1.5 grid size-11 shrink-0 place-items-center text-fg-subtle hover:text-fg"
              aria-label="閉じる"
            >
              ✕
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Link
              href={`/track/${sel.trackId}`}
              className="rounded-card border border-accent/40 bg-accent/8 px-3 py-2 text-center text-[13px] text-accent hover:border-accent/70"
            >
              曲ページ →
            </Link>
            <Link
              href={`/graph?mode=tree&root=${sel.trackId}`}
              className="rounded-card border border-hot/40 bg-hot/8 px-3 py-2 text-center text-[13px] text-hot hover:border-hot/70"
            >
              ここを起点に
            </Link>
          </div>
          {/*
            ツリーは「この先どこまで行けるか」を見る画面。枝が途切れている所ほど
            「ここに繋ぎを足したい」と思う場所なので、入力の入口をここにも置く。
            上の2つより控えめに（主役は曲ページとルート切り替え）
          */}
          <h3 data-edit className="label mb-1.5 mt-4">繋ぎを追加</h3>
          <div data-edit className="grid grid-cols-2 gap-2">
            <Link
              href={`/new?from=${sel.trackId}`}
              className="tap flex items-center justify-center rounded-card border border-border bg-surface-2 text-center text-[13px] text-fg-muted transition-colors hover:border-border-bright hover:text-fg"
            >
              この曲から →
            </Link>
            <Link
              href={`/new?to=${sel.trackId}`}
              className="tap flex items-center justify-center rounded-card border border-border bg-surface-2 text-center text-[13px] text-fg-muted transition-colors hover:border-border-bright hover:text-fg"
            >
              ← この曲へ
            </Link>
          </div>
        </aside>
      )}

      <p className="label absolute bottom-3 left-3 hidden md:block">
        琥珀 = 最長ルート · 同じ曲は経路ごとに現れます · クリックで詳細
      </p>
    </div>
  );
}
