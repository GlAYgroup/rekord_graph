/** サーバ側で組み立てて GraphExplorer に渡す、直列化可能なデータ。 */

export type GNode = {
  id: string;
  /** rekordbox の ContentID。配置パターンの保存キー（Notion を作り直しても残る） */
  rbId: string;
  name: string;
  bpm: number | null;
  musicalKey: string;
  out: number;
  in: number;
  /** この曲から最大何曲つなげるか（サーバで計算済み） */
  maxFrom: number;
};

export type GEdge = {
  id: string;
  source: string;
  target: string;
};

export type PanelTransition = {
  id: string;
  otherId: string;
  otherName: string;
  /** 相手の曲の BPM。テンポが合うかは曲名の次に見るものなので、行ごとに持たせる */
  otherBpm: number | null;
  fromCue: string; // 「G「助走 1サビ終受け」」形式
  toCue: string;
  comment: string;
  /** ★〜★★★★★ */
  rating: string | null;
  /** 要練習マーク（/practice に一覧が出る） */
  practice: boolean;
  /** 同時流し / ループ合わせ / カット / ビート合わせ */
  technique: string | null;
  bars: number | null;
};

export type PanelData = Record<string, { out: PanelTransition[]; in: PanelTransition[] }>;

/** 曲ID -> その曲を起点にした最長ルート */
export type RouteMap = Record<string, { trackIds: string[]; edgeIds: string[] }>;

/** 保存済みの配置パターン。座標のキーは rekordboxID */
export type GPattern = {
  id: string;
  name: string;
  positions: Record<string, { x: number; y: number }>;
};
