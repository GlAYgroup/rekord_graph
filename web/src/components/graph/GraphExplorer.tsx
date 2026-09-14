"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  LABEL_FONT, LABEL_LINE_H, type Layout, type Sim, labelWidth, seedNode, settle, wrapLabel,
} from "@/lib/layout";
import { usePerformance } from "@/components/PerformanceMode";
import { barsLabel } from "@/lib/format";
import { PracticeToggle } from "@/components/PracticeToggle";
import { RatingPicker } from "@/components/RatingPicker";
import type { GEdge, GNode, GPattern, PanelData, RouteMap } from "./types";

/**
 * Obsidian 風のグラフ探索画面。全画面キャンバス + 力学レイアウト。
 *
 * ライブラリは使わない。ノード数十個の規模なら自前の方が
 * 見た目を完全に制御でき、DJ 中に開く画面の依存も増えない。
 */

type Transform = { x: number; y: number; k: number };

/**
 * 前回どう開いていたか（絞り込みの状態と、開いていたパターン）の保存先。
 *
 * **配置そのものはここに入れない。** 形は Notion のパターンが正で、端末に持つと
 * 端末ごとに違う形が育つ（前にそれで PC とスマホの形がズレた）。
 * ここに置くのは「どのボタンを押していたか」だけなので、端末ごとで構わない。
 */
const VIEW_STORAGE = "rg.graph.view.v1";

type SavedView = {
  /** "solo" は廃止済み（古い保存を読めるように型だけ残す。読んだら「ルート強調」として扱う） */
  routeMode?: "off" | "highlight" | "solo";
  showIsolated?: boolean;
  multiMode?: boolean;
  /** 廃止済み（1/2/3 ホップ）。古い保存を読めるように型だけ残す */
  depth?: number | null;
  selected?: string | null;
  /** 開いていたパターン。自動配置なら null */
  patternId?: string | null;
};

/**
 * 全体表示のときに、これ以上は縮めない倍率。
 * ラベルは 11.5px なので 0.8 倍 = 実寸 9px。これ未満はブースの暗さでは読めない。
 */
const MIN_READABLE_K = 0.8;

/** 「パターン3」の次は「パターン4」。消した番号は再利用しない（同じ名前が別の形になると混乱する） */
function nextPatternName(list: GPattern[]): string {
  let max = 0;
  for (const p of list) {
    const m = /^パターン(\d+)$/.exec(p.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `パターン${max + 1}`;
}

export function GraphExplorer({
  nodes, edges, layout, patterns: initialPatterns, routes, overallRoute, panel, initialFocusId, stats,
}: {
  nodes: GNode[];
  edges: GEdge[];
  /** サーバが決めた配置。全デバイスで同じ形になるよう、ここが唯一の正 */
  layout: Layout;
  /** 保存済みの配置パターン。先頭 = 最後に保存したもの */
  patterns: GPattern[];
  routes: RouteMap;
  overallRoute: { trackIds: string[]; edgeIds: string[] };
  panel: PanelData;
  initialFocusId?: string;
  stats: { connected: number; transitions: number; longest: number };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  /**
   * 本番中は形を書き換えない。
   * ノードは指が当たっただけで動き、その1.2秒後に配置が Notion へ保存される。
   * プレイ中にそれが起きると、整えた形が本番の事故で上書きされる。
   */
  const { on: performing } = usePerformance();
  const performingRef = useRef(performing);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const degree = useCallback(
    (id: string) => (nodeById.get(id)?.out ?? 0) + (nodeById.get(id)?.in ?? 0),
    [nodeById],
  );

  /* ---------- 表示状態 ---------- */
  const [selected, setSelected] = useState<string | null>(
    initialFocusId && nodeById.has(initialFocusId) ? initialFocusId : null,
  );
  const [hover, setHover] = useState<string | null>(null);
  /**
   * 最長ルートの見せ方。
   *  off       … 何も光らせない（既定。どのノードも矢印も同じ色）
   *  highlight … 全部出したまま、ルートだけ琥珀で光らせる
   * （「ルート以外を消す」Solo もあったが、使われないので外した）
   */
  const [routeMode, setRouteMode] = useState<"off" | "highlight">("off");
  const glow = routeMode !== "off";
  const [showIsolated, setShowIsolated] = useState(false);
  const [q, setQ] = useState("");
  /** スマホの左上の引き出し（ルート強調・まとめて移動・未接続・配置パターン）を開いているか */
  const [toolsOpen, setToolsOpen] = useState(false);

  /**
   * まとめて動かす対象。
   * 塊ごと位置を直したいことが多いので、複数まとめて掴めるようにする。
   * PC は Shift+クリック、スマホは「まとめて移動」を押してからタップで足す。
   */
  const [moveSet, setMoveSet] = useState<Set<string>>(new Set());
  const [multiMode, setMultiMode] = useState(false);

  /* ---------- 配置パターン ---------- */
  // 保存先は Notion。端末に持たないので、PC で整えた形をスマホでそのまま開ける
  const [patterns, setPatterns] = useState(initialPatterns);
  const [activeId, setActiveId] = useState<string | null>(initialPatterns[0]?.id ?? null);
  /** 引き出しの中で「既定から変えているもの」があるか。閉じていても取っ手に点を出す */
  const toolsActive = routeMode !== "off" || showIsolated || multiMode || moveSet.size > 0;
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 「曲が増減したとき何を敷き直すか」を effect から読むための控え。更新は操作時だけ
  const patternsRef = useRef(patterns);
  const activeIdRef = useRef(activeId);

  const route = selected ? routes[selected] ?? overallRoute : overallRoute;
  /**
   * 選んだ曲から繋がっていく道筋（「最大N曲」の実体）。
   * 選択中は近傍以外を沈めるが、道筋まで沈むと「ここからどこまで行けるか」が
   * 読めなくなるので、道筋だけは沈めずに赤で通す。
   */
  const chainOn = !!selected && !!routes[selected];
  const routeNodeSet = useMemo(() => new Set(route.trackIds), [route]);
  const routeEdgeSet = useMemo(() => new Set(route.edgeIds), [route]);

  const connectedIds = useMemo(() => {
    const s = new Set<string>();
    for (const e of edges) { s.add(e.source); s.add(e.target); }
    return s;
  }, [edges]);

  /** 何を描くか */
  const visibleNodes = useMemo(
    () => nodes.filter((n) => showIsolated || connectedIds.has(n.id)),
    [nodes, showIsolated, connectedIds],
  );

  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(() => {
    return edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));
  }, [edges, visibleIds]);

  /* 検索: 一致ノードを光らせる */
  const matched = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return null;
    return new Set(nodes.filter((n) => n.name.toLowerCase().includes(query)).map((n) => n.id));
  }, [q, nodes]);

  /* ホバー/選択時の近傍。それ以外は沈める（Obsidian の作法） */
  const focusId = hover ?? selected;
  const neighborSet = useMemo(() => {
    if (!focusId) return null;
    const s = new Set([focusId]);
    for (const e of edges) {
      if (e.source === focusId) s.add(e.target);
      if (e.target === focusId) s.add(e.source);
    }
    return s;
  }, [focusId, edges]);

  /* ---------- 配置 ---------- */
  /**
   * 座標はサーバが計算したものをそのまま使う。**ここで力学を回さない**のが
   * 「どの端末から見ても形が同じ」の条件（端末ごとの再計算は誤差で別の形に落ちる）。
   * ドラッグで動かせるのは変わらないが、動かした結果は端末に保存しない。
   */
  const simRef = useRef<Map<string, Sim>>(new Map());
  const draggingRef = useRef<string | null>(null);
  const rafRef = useRef<number>(0);

  /**
   * 座標表を配置に反映する。`positions` が null なら自動配置（サーバ計算）に戻す。
   * 保存した形に無い曲（あとから増えた曲）だけ種から生やして馴染ませる。
   * 保存済みの曲は pinned なので動かない = 「保存した形は崩れない」。
   */
  const applyPositions = useCallback((positions: GPattern["positions"] | null) => {
    const sim = simRef.current;
    sim.clear();
    let placed = true;
    for (const n of nodes) {
      const p = positions ? positions[n.rbId || n.id] : layout[n.id];
      if (p) {
        sim.set(n.id, { id: n.id, x: p.x, y: p.y, vx: 0, vy: 0, pinned: true });
      } else {
        sim.set(n.id, seedNode(n.id));
        placed = false;
      }
    }
    // ラベルの箱を作るので label を渡す（サーバの計算と同じ規則で重なりを解く）
    if (!placed) settle(sim, nodes.map((n) => ({ id: n.id, label: n.name })), edges, 200);
    fitRef.current();
    tick();
  }, [nodes, edges, layout]);

  // 初回と、曲が増減したとき。開いているパターン（無ければ自動配置）を敷き直す
  useEffect(() => {
    applyPositions(patternsRef.current.find((p) => p.id === activeIdRef.current)?.positions ?? null);
    if (initialFocusIdRef.current) centerOnRef.current(initialFocusIdRef.current);
  }, [applyPositions]);

  /** 今の配置を rekordboxID で拾う。これがパターンとして保存される中身 */
  const currentPositions = useCallback(() => {
    const out: GPattern["positions"] = {};
    for (const n of nodes) {
      const s = simRef.current.get(n.id);
      if (s) out[n.rbId || n.id] = { x: Math.round(s.x), y: Math.round(s.y) };
    }
    return out;
  }, [nodes]);

  const adopt = useCallback((list: GPattern[], id: string | null) => {
    setPatterns(list); patternsRef.current = list;
    setActiveId(id); activeIdRef.current = id;
  }, []);

  /** `id` を渡すと上書き、渡さないと「パターンN」を新規作成 */
  const savePattern = useCallback(async (id?: string) => {
    setBusy(true); setSaveError(null);
    try {
      const name = (id && patternsRef.current.find((p) => p.id === id)?.name)
        || nextPatternName(patternsRef.current);
      const res = await fetch("/api/layouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name, positions: currentPositions() }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      adopt(data.patterns, data.pattern.id);
    } catch {
      setSaveError("保存できませんでした");
    } finally {
      setBusy(false);
    }
  }, [currentPositions, adopt]);

  /**
   * 名前だけを変える。空・同じ名前の別パターンは受け付けない
   * （名前で選ぶ画面なので、同じ名前が2つあるとどちらを開くのか分からない）。
   */
  const [renaming, setRenaming] = useState<string | null>(null);
  const renamePattern = useCallback(async (id: string, raw: string) => {
    const name = raw.trim();
    const current = patternsRef.current.find((p) => p.id === id);
    if (!current || name === current.name) { setRenaming(null); return; }
    if (!name) { setSaveError("名前が空です"); return; }
    if (patternsRef.current.some((p) => p.id !== id && p.name === name)) {
      setSaveError(`「${name}」は既にあります`);
      return;
    }
    setBusy(true); setSaveError(null);
    try {
      const res = await fetch("/api/layouts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      adopt(data.patterns, id);
      setRenaming(null);
    } catch {
      setSaveError("名前を変えられませんでした");
    } finally {
      setBusy(false);
    }
  }, [adopt]);

  const loadPattern = useCallback((id: string) => {
    const p = patternsRef.current.find((x) => x.id === id);
    if (!p) return;
    setActiveId(id); activeIdRef.current = id;
    applyPositions(p.positions);
  }, [applyPositions]);

  /** パターンを使わない自動配置に戻す（保存済みのパターンは消えない） */
  const useAutoLayout = useCallback(() => {
    setActiveId(null); activeIdRef.current = null;
    applyPositions(null);
  }, [applyPositions]);

  /**
   * 動かしたら勝手に残す。
   * 手で整えた形が消えるのが一番困るので、ドラッグを離したら少し待って保存する。
   * 開いているパターンがあればそれを上書き、無ければ新しいパターンを作って開く。
   */
  const savePatternRef = useRef(savePattern);
  savePatternRef.current = savePattern;
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoSavedAt, setAutoSavedAt] = useState(0);
  const scheduleAutoSave = useCallback(() => {
    if (performingRef.current) return; // 本番中は動かしても保存しない
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    // 連続でドラッグしている間は書かない。手が止まってから1回だけ
    autoSaveTimer.current = setTimeout(async () => {
      await savePatternRef.current(activeIdRef.current ?? undefined);
      setAutoSavedAt(Date.now());
    }, 1200);
  }, []);
  useEffect(() => () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); }, []);
  // 本番に入った瞬間、待機中の保存も捨てる（直前に触ってしまった分を書かせない）
  useEffect(() => {
    performingRef.current = performing;
    if (!performing) return;
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
  }, [performing]);

  const loadPatternRef = useRef(loadPattern);
  loadPatternRef.current = loadPattern;
  const useAutoLayoutRef = useRef(useAutoLayout);
  useAutoLayoutRef.current = useAutoLayout;

  const removePattern = useCallback(async (id: string) => {
    const p = patternsRef.current.find((x) => x.id === id);
    if (!window.confirm(`${p?.name ?? "このパターン"} を削除しますか？`)) return;
    setBusy(true); setSaveError(null);
    try {
      const res = await fetch(`/api/layouts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      adopt(data.patterns, null);
      applyPositions(null);
    } catch {
      setSaveError("削除できませんでした");
    } finally {
      setBusy(false);
    }
  }, [applyPositions, adopt]);

  // 表示する範囲を切り替えたら、その範囲に合わせて画面に収め直す
  // （未接続を出す / ルートだけに畳む で広さが大きく変わるため。形そのものは変えない）
  const firstFitRef = useRef(true);
  useEffect(() => {
    if (firstFitRef.current) { firstFitRef.current = false; return; }
    fitRef.current();
  }, [showIsolated, routeMode]);

  /* ---------- 前回の状態を復元する / 覚える ---------- */
  // 復元はマウント後に行う（初期値を変えると SSR と食い違ってハイドレーションが壊れる）
  const restoredRef = useRef(false);
  useEffect(() => {
    try {
      const v: SavedView | null = JSON.parse(localStorage.getItem(VIEW_STORAGE) ?? "null");
      if (v) {
        if (v.routeMode === "highlight" || v.routeMode === "solo") setRouteMode("highlight");
        if (typeof v.showIsolated === "boolean") setShowIsolated(v.showIsolated);
        if (typeof v.multiMode === "boolean") setMultiMode(v.multiMode);
        // ?from= で開いたときは、そちらを優先する（リンクで来た意図が勝つ）
        if (!initialFocusIdRef.current && typeof v.selected === "string" && nodeById.has(v.selected)) {
          setSelected(v.selected);
        }
        if (v.patternId === null) {
          useAutoLayoutRef.current();
        } else if (typeof v.patternId === "string" && v.patternId !== activeIdRef.current
                   && patternsRef.current.some((p) => p.id === v.patternId)) {
          loadPatternRef.current(v.patternId);
        }
      }
    } catch { /* 壊れた保存は無視して既定で開く */ }
    restoredRef.current = true;
  }, [nodeById]);

  useEffect(() => {
    if (!restoredRef.current) return; // 復元より先に既定値で上書きしない
    const view: SavedView = {
      routeMode, showIsolated, multiMode,
      selected, patternId: activeId,
    };
    try { localStorage.setItem(VIEW_STORAGE, JSON.stringify(view)); } catch { /* noop */ }
  }, [routeMode, showIsolated, multiMode, selected, activeId]);

  // ドラッグ中だけ描き直す。力学は回っていないので、動くのは掴んだノードだけ
  useEffect(() => {
    const loop = () => {
      if (draggingRef.current) tick();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  /* ---------- パン / ズーム / ドラッグ ---------- */
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /**
   * ジェスチャは増分方式で処理する（前フレームとの差分だけを適用）。
   * 開始時点の値に紐づけるとピンチ中のパンが効かない・指を減らしたとき
   * 状態が残る、という実バグを生んだため（レビューで確定）、起点は持たない。
   */
  const gesture = useRef<
    | { mode: "pan"; moved: number }
    | { mode: "node"; id: string; moved: number; additive: boolean }
    | { mode: "pinch" }
    /** 背景をドラッグして枠で囲む。additive = 今の選択に足す（⌘/Shift 押しながら） */
    | { mode: "band"; additive: boolean }
    /** 選択範囲の枠の中を掴んだ。選んだノードを全部動かす */
    | { mode: "group"; moved: number }
    | null
  >(null);
  /** 囲み枠（画面座標）。描画に要るので state で持つ */
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const bandRef = useRef(band);
  bandRef.current = band;

  /**
   * まとめて選んでいる範囲を囲む矩形（ワールド座標）。
   * **枠の中ならどこを掴んでも動かせる**ようにするための当たり判定でもある。
   * ドラッグ中も毎フレーム描き直すので memo にしない。
   */
  const selectionBox = () => {
    /*
      「まとめて移動」の状態は端末に残る（前回そのまま開く）。本番中は
      移動そのものをしないので、残っていた選択の枠も出さない。
      ノードのタップが選択に吸われる方は `onPointerUp` で塞いである
      （吸われるとパネルが開かず、本番中にいちばん要る「次にどのパッドか」が読めない）。
    */
    if (performing || moveSet.size === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of visibleNodes) {
      if (!moveSet.has(n.id)) continue;
      const s = simRef.current.get(n.id);
      if (!s) continue;
      const half = labelWidth(n.name) / 2 + 10;
      const below = wrapLabel(n.name).length * LABEL_LINE_H + 20;
      minX = Math.min(minX, s.x - half); maxX = Math.max(maxX, s.x + half);
      minY = Math.min(minY, s.y - 26); maxY = Math.max(maxY, s.y + below);
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  };

  const toWorld = useCallback((sx: number, sy: number) => {
    const t = transformRef.current;
    return { x: (sx - t.x) / t.k, y: (sy - t.y) / t.k };
  }, []);

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const fit = useCallback(() => {
    const el = containerRef.current;
    const sim = simRef.current;
    if (!el || visibleNodes.length === 0) return;
    // ラベルは円より横に広い。文字が切れないよう、箱ごと収める
    const boxes = visibleNodes
      .map((n) => {
        const s = sim.get(n.id);
        if (!s) return null;
        const half = labelWidth(n.name) / 2 + 12;
        const below = wrapLabel(n.name).length * LABEL_LINE_H + 26;
        return { x1: s.x - half, x2: s.x + half, y1: s.y - 28, y2: s.y + below };
      })
      .filter((b): b is NonNullable<typeof b> => !!b);
    if (boxes.length === 0) return;
    const minX = Math.min(...boxes.map((b) => b.x1)), maxX = Math.max(...boxes.map((b) => b.x2));
    const minY = Math.min(...boxes.map((b) => b.y1)), maxY = Math.max(...boxes.map((b) => b.y2));
    const { width: w, height: h } = el.getBoundingClientRect();
    const fitK = Math.min(w / (maxX - minX), h / (maxY - minY), 1.7);
    /**
     * 全体を収めようとすると、スマホでは曲名が 3〜6px になって読めなくなる。
     * **読めない全体図より、読める一部**を出す（暗いブースで見る画面なので）。
     * 収まりきらないときは、いちばん繋がっている曲を中心にして残りはパンで見る。
     */
    const k = Math.max(fitK, MIN_READABLE_K);
    if (k === fitK) {
      setTransform({ k, x: w / 2 - ((minX + maxX) / 2) * k, y: h / 2 - ((minY + maxY) / 2) * k });
      return;
    }
    const hub = [...visibleNodes].sort(
      (a, b) => (b.out + b.in) - (a.out + a.in) || (a.id < b.id ? -1 : 1),
    )[0];
    const s = hub ? sim.get(hub.id) : undefined;
    const cx = s ? s.x : (minX + maxX) / 2;
    const cy = s ? s.y : (minY + maxY) / 2;
    setTransform({ k, x: w / 2 - cx * k, y: h / 2 - cy * k });
  }, [visibleNodes]);

  const centerOn = useCallback((id: string) => {
    const el = containerRef.current;
    const s = simRef.current.get(id);
    if (!el || !s) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    setTransform((t) => ({ ...t, x: w / 2 - s.x * t.k, y: h / 2 - s.y * t.k }));
  }, []);

  // rAF ループから最新の fit / centerOn を呼ぶための参照
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const centerOnRef = useRef(centerOn);
  centerOnRef.current = centerOn;
  const initialFocusIdRef = useRef(initialFocusId);

  // Esc でまとめて移動の選択を解除する（掴み損ねたときの逃げ道）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoveSet(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 選択解除 */
  const clearSelection = useCallback(() => {
    setSelected(null);
  }, []);

  // 画面サイズが変わったら（回転・ウィンドウリサイズ・分割表示）フィットし直す。
  // 形そのものは変えず、画面に収める倍率だけを合わせる（スマホと PC の違いはここだけ）。
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

  // wheel は React 経由だと passive になるので、自前で non-passive を張る
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = localPoint(e);
      setTransform((t) => {
        const k = Math.min(3, Math.max(0.2, t.k * Math.exp(-e.deltaY * 0.0016)));
        return { k, x: p.x - ((p.x - t.x) / t.k) * k, y: p.y - ((p.y - t.y) / t.k) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent, nodeId?: string) => {
    // 指を離した直後などにキャプチャが取れないことがある。取れなくても操作自体は続けられる
    try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); } catch { /* noop */ }
    pointers.current.set(e.pointerId, localPoint(e));
    if (pointers.current.size >= 2) {
      // 2本目が付いたらピンチへ。ノードドラッグと囲み枠は中断する
      draggingRef.current = null;
      setBand(null);
      gesture.current = { mode: "pinch" };
    } else if (nodeId) {
      // Shift / Cmd / Ctrl 押しながらは「選択に足す」（PC の作法）
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      gesture.current = { mode: "node", id: nodeId, moved: 0, additive };
      draggingRef.current = nodeId; // rAF を回して描画を追従させるためだけに使う
    } else {
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      const p0 = localPoint(e);
      const w0 = toWorld(p0.x, p0.y);
      const box = selectionBox();
      // 選択範囲の枠の中を掴んだら、ノードを狙わなくてもまとめて動かせる
      if (box && !additive && !performing
          && w0.x >= box.minX && w0.x <= box.maxX && w0.y >= box.minY && w0.y <= box.maxY) {
        gesture.current = { mode: "group", moved: 0 };
        draggingRef.current = "__group"; // rAF を回して追従させる
        return;
      }
      // 背景のドラッグ: まとめて移動モード（か ⌘/Shift 押し）なら枠で囲む、それ以外はパン
      if ((multiMode || additive) && !performing) {
        const p = localPoint(e);
        gesture.current = { mode: "band", additive };
        setBand({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      } else {
        gesture.current = { mode: "pan", moved: 0 };
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = localPoint(e);
    const prev = pointers.current.get(e.pointerId)!;
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;

    if (g.mode === "pinch") {
      const others = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId);
      if (others.length === 0) return;
      const o = others[0][1]; // もう1本の指（動いていないので prev == 現在）
      const prevMid = { x: (prev.x + o.x) / 2, y: (prev.y + o.y) / 2 };
      const curMid = { x: (p.x + o.x) / 2, y: (p.y + o.y) / 2 };
      const prevDist = Math.max(1, Math.hypot(prev.x - o.x, prev.y - o.y));
      const curDist = Math.max(1, Math.hypot(p.x - o.x, p.y - o.y));
      setTransform((t) => {
        const k = Math.min(3, Math.max(0.2, t.k * (curDist / prevDist)));
        // 前フレームの中点の下にあったワールド座標を、今の中点の下に保つ
        return {
          k,
          x: curMid.x - ((prevMid.x - t.x) / t.k) * k,
          y: curMid.y - ((prevMid.y - t.y) / t.k) * k,
        };
      });
    } else if (g.mode === "group") {
      g.moved += Math.hypot(p.x - prev.x, p.y - prev.y);
      const w = toWorld(p.x, p.y), wPrev = toWorld(prev.x, prev.y);
      const dx = w.x - wPrev.x, dy = w.y - wPrev.y;
      for (const id of moveSet) {
        const s = simRef.current.get(id);
        if (!s) continue;
        s.x += dx; s.y += dy; s.vx = 0; s.vy = 0;
      }
    } else if (g.mode === "band") {
      setBand((b) => (b ? { ...b, x1: p.x, y1: p.y } : b));
    } else if (g.mode === "pan") {
      g.moved += Math.hypot(p.x - prev.x, p.y - prev.y);
      setTransform((t) => ({ ...t, x: t.x + (p.x - prev.x), y: t.y + (p.y - prev.y) }));
    } else if (g.mode === "node") {
      g.moved += Math.hypot(p.x - prev.x, p.y - prev.y);
      // 本番中はノードを動かさない。指が滑ったぶんは地図のパンとして扱う
      if (performing) {
        setTransform((t) => ({ ...t, x: t.x + (p.x - prev.x), y: t.y + (p.y - prev.y) }));
        return;
      }
      // 差分で動かす（掴んだ点との位置関係が保たれる。まとめて動かすのにも要る）
      const w = toWorld(p.x, p.y), wPrev = toWorld(prev.x, prev.y);
      const dx = w.x - wPrev.x, dy = w.y - wPrev.y;
      const group = moveSet.has(g.id) && moveSet.size > 1 ? [...moveSet] : [g.id];
      for (const id of group) {
        const s = simRef.current.get(id);
        if (!s) continue;
        s.x += dx; s.y += dy; s.vx = 0; s.vy = 0;
      }
    }
  };

  const selectNode = useCallback((id: string) => {
    setSelected((cur) => (cur === id ? null : id));
  }, []);

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.mode === "node") {
      draggingRef.current = null;
      if (g.moved < 6) {
        // 動かしていない = タップ。まとめて移動モード（か Shift）なら選択に出し入れする
        if ((multiMode || g.additive) && !performing) {
          setMoveSet((cur) => {
            const next = new Set(cur);
            if (next.has(g.id)) next.delete(g.id); else next.add(g.id);
            return next;
          });
        } else {
          selectNode(g.id);
        }
      } else if (!performing) {
        const moved = moveSet.has(g.id) && moveSet.size > 1 ? [...moveSet] : [g.id];
        for (const id of moved) {
          const s = simRef.current.get(id);
          if (s) s.pinned = true; // 置いた場所に固定する
        }
        scheduleAutoSave();
      }
    }
    // 何もない所を「タップ」したら選択を解除する（✕ と同じ）。
    // 動かしていればパンなので、そのときは触らない
    if (g?.mode === "pan" && g.moved < 6 && (selected || moveSet.size > 0)) {
      clearSelection();
      setMoveSet(new Set());
    }
    if (g?.mode === "group") {
      draggingRef.current = null;
      if (g.moved >= 6) {
        for (const id of moveSet) {
          const s = simRef.current.get(id);
          if (s) s.pinned = true;
        }
        scheduleAutoSave();
      }
    }
    if (g?.mode === "band") {
      const b = bandRef.current;
      if (b) {
        // 画面座標の枠をワールド座標に直して、中心が入っているノードを拾う
        const a1 = toWorld(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1));
        const a2 = toWorld(Math.max(b.x0, b.x1), Math.max(b.y0, b.y1));
        const hit = visibleNodes.filter((n) => {
          const s = simRef.current.get(n.id);
          return !!s && s.x >= a1.x && s.x <= a2.x && s.y >= a1.y && s.y <= a2.y;
        }).map((n) => n.id);
        const dragged = Math.abs(b.x1 - b.x0) > 4 || Math.abs(b.y1 - b.y0) > 4;
        if (dragged) {
          setMoveSet((cur) => (g.additive ? new Set([...cur, ...hit]) : new Set(hit)));
        }
      }
      setBand(null);
    }
    if (pointers.current.size === 1 && g?.mode === "pinch") {
      gesture.current = { mode: "pan", moved: 0 }; // 残った1本でそのままパンを続けられる
    } else if (pointers.current.size === 0) {
      gesture.current = null;
      draggingRef.current = null; // どの経路で終わっても必ず解放する
    }
  };

  /* ---------- 描画 ---------- */
  const chip = (on: boolean) =>
    `tap rounded-full border px-4 text-[12px] backdrop-blur transition-colors ${
      on ? "border-accent/60 bg-accent/12 text-accent" : "border-border bg-surface/90 text-fg-muted hover:text-fg"
    }`;
  const radius = (id: string) => 6 + Math.min(11, degree(id) * 1.8);
  const dimmed = (id: string) =>
    (neighborSet && !neighborSet.has(id)) || (matched && !matched.has(id));

  const sel = selected ? nodeById.get(selected) : null;
  const selPanel = selected ? panel[selected] : null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-x-0 top-0 bottom-[var(--nav-h)] touch-none select-none overflow-hidden bg-bg-deep md:bottom-0 md:left-16"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* 奥行き: 中央の弱い発光 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(60% 60% at 50% 45%, color-mix(in srgb, var(--accent) 5%, transparent), transparent 70%)" }}
      />

      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        onPointerDown={(e) => onPointerDown(e)}
        aria-label="曲の繋がりグラフ。ドラッグで移動、ホイールで拡大縮小"
      >
        <defs>
          <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
          </marker>
        </defs>
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {/* まとめて選んでいる範囲。この中ならどこを掴んでも一緒に動く */}
          {(() => {
            const box = selectionBox();
            if (!box) return null;
            return (
              <rect
                x={box.minX} y={box.minY}
                width={box.maxX - box.minX} height={box.maxY - box.minY}
                rx={10}
                fill="color-mix(in srgb, var(--accent) 7%, transparent)"
                stroke="var(--accent)"
                strokeWidth={1.5 / transform.k}
                strokeDasharray={`${6 / transform.k} ${4 / transform.k}`}
                pointerEvents="none"
              />
            );
          })()}
          {visibleEdges.map((e) => {
            const a = simRef.current.get(e.source);
            const b = simRef.current.get(e.target);
            if (!a || !b) return null;
            const d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
            const ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
            const r1 = radius(e.source) + 2, r2 = radius(e.target) + 5;
            // 選んだ曲からの道筋は赤。沈める処理より優先する（薄い道筋は追えない）
            const isChain = chainOn && routeEdgeSet.has(e.id);
            // 琥珀で光らせるのはルート強調で全体の最長ルートを見るとき。普段はどの線も同じ太さ・同じ明るさ
            const isRoute = !chainOn && glow && routeEdgeSet.has(e.id);
            /**
             * 選んだ曲に直接つながっている線。選択への「返事」なのではっきり返す。
             * **向きで色を分ける** — 出ていく（ここから行ける）= シアン、
             * 入ってくる（ここに入ってこれる）= 藤色。矢羽根だけだと、線が密なところや
             * ズームアウト時に「どっちが行き先か」を一本ずつ追う羽目になるため。
             */
            const isOut = !!focusId && e.source === focusId;
            const isIn = !!focusId && e.target === focusId;
            const isLinked = isOut || isIn;
            const dim = dimmed(e.source) || dimmed(e.target);
            const color = isChain
              ? "var(--route)"
              : isRoute
                ? "var(--hot)"
                : isOut
                  ? "var(--accent)"
                  : isIn
                    ? "var(--incoming)"
                    : "var(--border-bright)";
            const opacity = isChain ? 1 : dim ? 0.08 : isRoute ? 0.95 : isLinked ? 0.9 : 0.55;
            /**
             * 向きの矢羽根。終端の矢先はノードの根元に埋もれ、ズームアウトで潰れて
             * 「どっち向きか」が読めなかった。線の途中（終点寄り 60%）に、
             * **画面上の大きさが変わらない**矢羽根を置く（/k でズームを打ち消す）。
             * 短い線では線の長さに合わせて縮める（矢羽根が線からはみ出すと向きが逆に読める）。
             */
            const x1 = a.x + ux * r1, y1 = a.y + uy * r1;
            const x2 = b.x - ux * r2, y2 = b.y - uy * r2;
            const mx = x1 + (x2 - x1) * 0.6, my = y1 + (y2 - y1) * 0.6;
            const aw = Math.min(8 / transform.k, d * 0.22);
            const ang = (Math.atan2(uy, ux) * 180) / Math.PI;
            return (
              <g key={e.id} style={{ transition: "opacity 0.18s" }}>
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={color}
                  strokeWidth={isChain ? 2.6 : isRoute ? 2.2 : isLinked ? 2 : 1.2}
                  strokeOpacity={opacity}
                  markerEnd="url(#ar)"
                  style={{ transition: "stroke-opacity 0.18s" }}
                />
                <path
                  d={`M${-aw},${-aw * 0.62} L${aw},0 L${-aw},${aw * 0.62} Z`}
                  transform={`translate(${mx},${my}) rotate(${ang})`}
                  fill={color}
                  // 矢羽根は線より一段はっきり出す（向きが要点なので）。沈めた線の矢羽根は沈んだまま
                  fillOpacity={dim && !isChain ? opacity : Math.min(1, opacity + 0.25)}
                  style={{ transition: "fill-opacity 0.18s" }}
                />
              </g>
            );
          })}

          {visibleNodes.map((n) => {
            const s = simRef.current.get(n.id);
            if (!s) return null;
            const r = radius(n.id);
            const isChain = chainOn && routeNodeSet.has(n.id); // 選んだ曲からの道筋は赤で通す
            const isRoute = !chainOn && glow && routeNodeSet.has(n.id); // off のときはどのノードも同じ色
            const isSel = selected === n.id;
            const isMatch = matched?.has(n.id);
            const inMoveSet = moveSet.has(n.id);
            const dim = dimmed(n.id);
            // 選んだ曲の隣（＝そこから行ける・そこへ入ってこれる曲）。沈めた曲との差をはっきり付ける
            const isLinked = !!focusId && n.id !== focusId && !!neighborSet?.has(n.id);
            return (
              <g
                key={n.id}
                transform={`translate(${s.x},${s.y})`}
                opacity={dim && !isChain ? 0.14 : 1}
                style={{ transition: "opacity 0.18s" }}
                className="cursor-pointer outline-none focus-visible:opacity-100"
                tabIndex={0}
                role="button"
                aria-label={`${n.name} を選択`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectNode(n.id); }
                }}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover((h) => (h === n.id ? null : h))}
                onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, n.id); }}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
              >
                {(isSel || isMatch) && (
                  <circle r={r + 7} fill="none" stroke="var(--accent)" strokeWidth={1.4}
                    strokeDasharray={isMatch && !isSel ? "3 3" : undefined} opacity={0.85} />
                )}
                {/* まとめて動かす対象。掴めば全部いっしょに動く */}
                {inMoveSet && (
                  <circle r={r + 11} fill="none" stroke="var(--accent)" strokeWidth={2} opacity={0.9} />
                )}
                {isChain && <circle r={r + 3.5} fill="color-mix(in srgb, var(--route) 20%, transparent)" />}
                {isRoute && <circle r={r + 3.5} fill="color-mix(in srgb, var(--hot) 14%, transparent)" />}
                {/* 道筋（赤）・ルート（琥珀）と重ねない。同じ丸に2色の暈しが乗ると濁って読めなくなる */}
                {isLinked && !isRoute && !isChain && (
                  <circle r={r + 3.5} fill="color-mix(in srgb, var(--accent) 16%, transparent)" />
                )}
                <circle
                  r={r}
                  fill={
                    isChain ? "color-mix(in srgb, var(--route) 32%, var(--elevated))"
                      : isRoute ? "color-mix(in srgb, var(--hot) 30%, var(--elevated))"
                      : isLinked ? "color-mix(in srgb, var(--accent) 26%, var(--elevated))"
                      : "var(--elevated)"
                  }
                  stroke={
                    isSel ? "var(--accent)"
                      : isChain ? "var(--route)"
                      : isRoute ? "var(--hot)"
                      : isLinked ? "var(--accent)"
                      : "var(--border-bright)"
                  }
                  strokeWidth={isSel ? 2 : isLinked ? 1.8 : 1.2}
                />
                <text
                  textAnchor="middle"
                  fontSize={LABEL_FONT}
                  fill={isChain || isRoute || isSel || isLinked ? "var(--fg)" : "var(--fg-muted)"}
                  stroke="var(--bg-deep)"
                  strokeWidth="3.5"
                  paintOrder="stroke"
                  style={{ fontFamily: "var(--font-sans)" }}
                >
                  {/* 曲名は省略しない。長いものは折り返す（配置計算も同じ規則で箱を作っている） */}
                  {wrapLabel(n.name).map((line, i) => (
                    <tspan key={line + i} x={0} y={r + 14 + i * LABEL_LINE_H}>{line}</tspan>
                  ))}
                </text>
              </g>
            );
          })}
        </g>
        {/* 囲み枠。画面座標なので transform の外に置く */}
        {band && (
          <rect
            x={Math.min(band.x0, band.x1)}
            y={Math.min(band.y0, band.y1)}
            width={Math.abs(band.x1 - band.x0)}
            height={Math.abs(band.y1 - band.y0)}
            fill="color-mix(in srgb, var(--accent) 10%, transparent)"
            stroke="var(--accent)"
            strokeWidth={1.2}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        )}
      </svg>

      {/*
        ── 左上: 検索と絞り込み ──
        スマホでは「ネットワーク / ツリー / 検索」だけを常に出し、残り（ルート強調・
        まとめて移動・未接続・配置パターン）は「表示・配置」で開く引き出しに入れる。
        全部出しっぱなしだと、画面の上半分がボタンで埋まってグラフが見えない。
        PC（md 以上）は場所に余裕があるので引き出しにせず常に出す
      */}
      <div className="absolute left-3 top-3 flex w-[min(280px,calc(100%-24px))] flex-col gap-2">
        <div className="flex gap-1.5">
          <span className="tap flex shrink-0 items-center whitespace-nowrap rounded-full border border-accent/60 bg-accent/12 px-3.5 text-[12px] text-accent backdrop-blur">
            ネットワーク
          </span>
          <Link
            href={`/graph?mode=tree${selected ? `&root=${selected}` : ""}`}
            className="tap flex shrink-0 items-center whitespace-nowrap rounded-full border border-border bg-surface/90 px-3.5 text-[12px] text-fg-muted backdrop-blur hover:text-fg"
            title="起点から右へ分岐を展開するツリー表示"
          >
            ツリー
          </Link>
          {/* 引き出しの取っ手（スマホだけ）。何か効いているときは点を付ける = 閉じていても気づける */}
          <button
            onClick={() => setToolsOpen((v) => !v)}
            aria-expanded={toolsOpen}
            className={`tap relative ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-[12px] backdrop-blur transition-colors md:hidden ${
              toolsOpen ? "border-fg-subtle bg-elevated text-fg" : "border-border bg-surface/90 text-fg-muted"
            }`}
            title="ルート強調・まとめて移動・未接続・配置パターン"
          >
            表示・配置 <span aria-hidden className="text-[10px]">{toolsOpen ? "▲" : "▼"}</span>
            {!toolsOpen && toolsActive && (
              <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-hot" aria-label="設定が効いています" />
            )}
          </button>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !matched) return;
            const first = nodes.find((n) => matched.has(n.id));
            if (first) { setSelected(first.id); centerOn(first.id); }
          }}
          placeholder="グラフ内を検索"
          className="h-12 rounded-card border border-border bg-surface/90 px-3.5 text-[16px] outline-none backdrop-blur placeholder:text-fg-subtle focus:border-accent"
        />
        <div className={`${toolsOpen ? "flex" : "hidden"} flex-col gap-2 md:flex`}>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setRouteMode((m) => (m === "highlight" ? "off" : "highlight"))}
            className={`tap rounded-full border px-4 text-[12px] backdrop-blur transition-colors ${
              routeMode === "highlight"
                ? "border-hot/60 bg-hot/15 text-hot"
                : "border-border bg-surface/90 text-fg-muted hover:text-fg"
            }`}
            title="全部出したまま、最長ルートだけ琥珀で光らせる"
          >
            ルート強調
          </button>
          <button
            data-edit
            onClick={() => {
              setMultiMode((v) => !v);
              if (multiMode) setMoveSet(new Set()); // 抜けるときは選択も畳む
            }}
            className={`tap rounded-full border px-4 text-[12px] backdrop-blur transition-colors ${
              multiMode ? "border-accent/60 bg-accent/12 text-accent" : "border-border bg-surface/90 text-fg-muted hover:text-fg"
            }`}
            title="背景をドラッグして枠で囲む / ノードをタップで足す。選択範囲の枠の中ならどこを掴んでも一緒に動く。このモード中のパンは2本指（PC は ⌘・Shift 押しながらでも同じ）"
          >
            まとめて移動
          </button>
          {multiMode && (
            <button
              data-edit
              onClick={() => setMoveSet(new Set(visibleNodes.map((n) => n.id)))}
              className="tap rounded-full border border-border bg-surface/90 px-4 text-[12px] text-fg-muted backdrop-blur hover:text-fg"
              title="見えているノードを全部選ぶ"
            >
              全選択
            </button>
          )}
          {moveSet.size > 0 && (
            <button
              onClick={() => setMoveSet(new Set())}
              className="tap rounded-full border border-accent/60 bg-accent/12 px-4 text-[12px] text-accent backdrop-blur"
              title="選択を外す"
            >
              {moveSet.size}曲 ✕
            </button>
          )}
          <button
            onClick={() => setShowIsolated((v) => !v)}
            className={`tap rounded-full border px-4 text-[12px] backdrop-blur transition-colors ${
              showIsolated ? "border-fg-subtle bg-elevated text-fg" : "border-border bg-surface/90 text-fg-subtle hover:text-fg-muted"
            }`}
          >
            未接続も表示
          </button>
        </div>

        {/* ── 配置パターン。整えた形に名前を付けて Notion に置く（端末をまたいで同じ形） ── */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={useAutoLayout}
            className={chip(activeId === null)}
            title="保存した形を使わず、自動配置で見る"
          >
            自動
          </button>
          {patterns.map((p) => (
            <button
              key={p.id}
              onClick={() => loadPattern(p.id)}
              className={chip(activeId === p.id)}
              title={`${p.name}（${Object.keys(p.positions).length}曲）を読み込む`}
            >
              {p.name}
            </button>
          ))}
          <button
            data-edit
            onClick={() => savePattern()}
            disabled={busy}
            className="tap rounded-full border border-hot/50 bg-hot/12 px-4 text-[12px] text-hot backdrop-blur transition-colors disabled:opacity-40"
            title="今の形を別のパターンとして保存する（動かした位置は自動で保存されます）"
          >
            ＋保存
          </button>
          {activeId && renaming === activeId && (
            // 名前の入力欄。Enter で決定、Esc / 欄の外で取り消し
            <form
              data-edit
              className="flex basis-full gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const v = new FormData(e.currentTarget).get("name");
                renamePattern(activeId, typeof v === "string" ? v : "");
              }}
            >
              <input
                name="name"
                autoFocus
                defaultValue={patterns.find((p) => p.id === activeId)?.name ?? ""}
                maxLength={100}
                onKeyDown={(e) => { if (e.key === "Escape") { setRenaming(null); setSaveError(null); } }}
                onFocus={(e) => e.currentTarget.select()}
                className="h-11 min-w-0 flex-1 rounded-full border border-accent/60 bg-surface px-4 text-[16px] text-fg outline-none"
                aria-label="パターンの名前"
              />
              <button
                type="submit"
                disabled={busy}
                className="tap shrink-0 rounded-full border border-accent/60 bg-accent/12 px-4 text-[12px] text-accent disabled:opacity-40"
              >
                決定
              </button>
              <button
                type="button"
                onClick={() => { setRenaming(null); setSaveError(null); }}
                className="tap shrink-0 rounded-full border border-border bg-surface/90 px-3 text-[12px] text-fg-subtle hover:text-fg"
              >
                やめる
              </button>
            </form>
          )}
          {activeId && renaming !== activeId && (
            <div data-edit className="flex gap-1.5">
              <button
                onClick={() => { setSaveError(null); setRenaming(activeId); }}
                disabled={busy}
                className="tap rounded-full border border-border bg-surface/90 px-4 text-[12px] text-fg-muted backdrop-blur transition-colors hover:text-fg disabled:opacity-40"
                title="開いているパターンの名前を変える（配置はそのまま）"
              >
                名前を変更
              </button>
              <button
                onClick={() => savePattern(activeId)}
                disabled={busy}
                className="tap rounded-full border border-border bg-surface/90 px-4 text-[12px] text-fg-muted backdrop-blur transition-colors hover:text-fg disabled:opacity-40"
                title="今の形で、開いているパターンを上書きする"
              >
                上書き
              </button>
              <button
                onClick={() => removePattern(activeId)}
                disabled={busy}
                className="tap rounded-full border border-border bg-surface/90 px-4 text-[12px] text-fg-subtle backdrop-blur transition-colors hover:text-warn disabled:opacity-40"
              >
                削除
              </button>
            </div>
          )}
        </div>
        </div>
        {/* 保存の結果は引き出しの外に出す（閉じていても失敗に気づけるように） */}
        {saveError ? (
          <p className="text-[12px] text-warn">{saveError}</p>
        ) : busy ? (
          <p className="text-[12px] text-fg-subtle">保存中…</p>
        ) : autoSavedAt ? (
          <p className="text-[12px] text-fg-subtle">動かした位置は自動保存されます</p>
        ) : null}
      </div>

      {/* ── 右上: 統計 ── */}
      <div className="absolute right-3 top-3 hidden gap-2 sm:flex">
        {[
          [stats.longest, "最長"], [stats.connected, "接続曲"], [stats.transitions, "繋ぎ"],
        ].map(([v, l]) => (
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
                const k = Math.min(3, Math.max(0.2, t.k * f));
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
      {sel && selPanel && (
        <aside className="absolute inset-x-0 bottom-0 max-h-[46%] overflow-y-auto rounded-t-2xl border-t border-border bg-surface/95 backdrop-blur-md md:inset-x-auto md:bottom-auto md:right-3 md:top-16 md:max-h-[calc(100%-110px)] md:w-[320px] md:rounded-card md:border">
          <div className="sticky top-0 flex items-start gap-2 border-b border-border bg-surface/95 p-4 backdrop-blur">
            <div className="min-w-0 flex-1">
              <h2 className="text-[18px] font-bold leading-tight break-words">{sel.name}</h2>
              <p className="mt-0.5 font-mono text-[12px] tabular-nums text-fg-muted">
                {sel.bpm ?? "–"} BPM{sel.musicalKey && ` · ${sel.musicalKey}`}
                <span className="text-hot"> · 最大{sel.maxFrom}曲</span>
              </p>
            </div>
            <button
              onClick={clearSelection}
              className="tap -m-1.5 grid size-11 shrink-0 place-items-center text-fg-subtle hover:text-fg"
              aria-label="閉じる"
            >
              ✕
            </button>
          </div>
          <div className="space-y-4 p-4">
            <Link
              href={`/track/${sel.id}`}
              className="block rounded-card border border-accent/40 bg-accent/8 px-4 py-2.5 text-center text-[14px] text-accent transition-colors hover:border-accent/70"
            >
              曲ページを開く →
            </Link>
            {/*
              グラフを見ていて「ここが繋がるな」と気づいた場に、入力の入口を置く。
              入力画面はこの曲が入った状態で開く。
              曲ページのボタンより控えめにする: 主役はあくまで上の1つで、
              2つとも同じ強さで光ると、暗所でどちらを押すのか一瞬迷う
            */}
            <section data-edit>
              <h3 className="label mb-1.5">繋ぎを追加</h3>
              <div className="grid grid-cols-2 gap-2">
                <Link
                  href={`/new?from=${sel.id}`}
                  className="tap flex items-center justify-center rounded-card border border-border bg-surface-2 text-center text-[13px] text-fg-muted transition-colors hover:border-border-bright hover:text-fg"
                >
                  この曲から →
                </Link>
                <Link
                  href={`/new?to=${sel.id}`}
                  className="tap flex items-center justify-center rounded-card border border-border bg-surface-2 text-center text-[13px] text-fg-muted transition-colors hover:border-border-bright hover:text-fg"
                >
                  ← この曲へ
                </Link>
              </div>
            </section>
            {(["out", "in"] as const).map((dir) =>
              selPanel[dir].length === 0 ? null : (
                <section key={dir}>
                  {/* 見出しの色 = グラフの線の色。どっちの色がどっちの向きかを、
                      凡例を読まなくても選んだその場で結び付けられるようにする */}
                  <h3 className={`label ${dir === "out" ? "text-accent" : "text-incoming"}`}>
                    {dir === "out" ? "ここから行ける" : "ここに入ってこれる"} · {selPanel[dir].length}
                  </h3>
                  {/* 並びの根拠は書いておく。数字が右に出ているだけだと「なぜこの順か」が読めない */}
                  <p className="label mb-1.5 text-fg-subtle">この先つなげる曲数が多い順</p>
                  <ul className="space-y-1.5">
                    {selPanel[dir].map((t) => (
                      <li key={t.id} className="rounded-lg border border-border bg-surface-2">
                        <button
                          onClick={() => { setSelected(t.otherId); centerOn(t.otherId); }}
                          className="block w-full rounded-t-lg px-3 py-2 text-left transition-colors hover:bg-elevated"
                        >
                          {/* 曲名の右に BPM と「この先つなげる曲数」。
                              テンポが分からないと「その繋ぎが今できるか」を、
                              先の長さが分からないと「そこへ行って続くか」を、
                              パネルだけでは判断できない（一覧はこの数が多い順） */}
                          <span className="flex items-baseline gap-2 text-[13.5px]">
                            <span className="min-w-0 flex-1 break-words">
                              {dir === "out" ? "▸ " : "◂ "}{t.otherName}
                            </span>
                            <span className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[11px] tabular-nums">
                              <span className="text-fg-subtle">
                                {t.otherBpm ?? "–"}
                                <span className="ml-0.5 text-[9px] tracking-wide">BPM</span>
                              </span>
                              <span
                                className={t.otherMaxFrom > 1 ? "text-hot" : "text-fg-subtle"}
                                title={`${t.otherName} から先は最大${t.otherMaxFrom}曲つなげます（全曲を使える前提）`}
                              >
                                {t.otherMaxFrom > 1 ? `最大${t.otherMaxFrom}曲` : "行き止まり"}
                              </span>
                            </span>
                          </span>
                          <span className="block font-mono text-[11px] text-fg-subtle break-words">
                            {t.fromCue} → {t.toCue}
                          </span>
                          {(t.technique || barsLabel(t, t.toCue)) && (
                            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px]">
                              {t.technique && <span className="text-fg-muted">{t.technique}</span>}
                              {barsLabel(t, t.toCue) && (
                                <span className="tabular-nums text-fg-subtle">{barsLabel(t, t.toCue)}</span>
                              )}
                            </span>
                          )}
                          {t.comment && (
                            <span className="mt-0.5 block text-[12px] text-fg-muted break-words">{t.comment}</span>
                          )}
                        </button>
                        {/*
                          星と「編集」はここで直接触る（グラフを見ながら直せる）。
                          曲へ飛ぶボタンの外に出す: 中に入れるとタップが移動に食われる。
                          「編集」は入力画面をこの繋ぎで開く = どのキュー同士を結ぶかを付け替える口。
                        */}
                        <div data-edit className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-0.5">
                          <RatingPicker id={t.id} value={t.rating} size="sm" className="ml-auto" />
                          <PracticeToggle id={t.id} value={t.practice} />
                          <Link
                            href={`/new?edit=${t.id}`}
                            className="tap inline-flex items-center shrink-0 rounded-full border border-border px-3 text-[11.5px] text-fg-subtle transition-colors hover:border-border-bright hover:text-fg"
                            title="この繋ぎのキュー・種類・コメントを直す"
                          >
                            編集
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ),
            )}
          </div>
        </aside>
      )}

      {/* ── 左下: 凡例。本番中は「動かせる」と書かない（実際に動かないため） ── */}
      <p className="label absolute bottom-3 left-3 hidden md:block">
        {performing ? (
          <>本番中 · 曲を選ぶとそこからの道筋を赤で出す · 出ていく線はシアン / 入ってくる線は藤色 · ドラッグは地図の移動だけ（形は書き換わりません）</>
        ) : (
          <>
            曲を選ぶとそこからの道筋を赤で出す · 出ていく線はシアン / 入ってくる線は藤色 · ルート強調 = 全体の最長ルートを琥珀 · ホバーで近傍 · クリックで詳細 ·
            ドラッグで移動 · ⌘/Shift+クリックで複数選択 · 背景を⌘/Shift+ドラッグで囲んで選択 · 選択枠の中はどこを掴んでも動く
          </>
        )}
      </p>
    </div>
  );
}
