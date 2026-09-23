/** サーバ側で組み立てて GraphExplorer に渡す、直列化可能なデータ。 */

export type GNode = {
  id: string;
  /** rekordbox の ContentID。配置パターンの保存キー（Notion を作り直しても残る） */
  rbId: string;
  name: string;
  /** 検索用。表示名・別名・原題をつないで NFKC＋小文字にしたもの（曲一覧の検索と同じ範囲） */
  search: string;
  bpm: number | null;
  musicalKey: string;
  out: number;
  in: number;
  /** この曲から最大何曲つなげるか（サーバで計算済み） */
  maxFrom: number;
  /** 除外条件（`lib/playFilter.ts`）の判定と、端末での数え直し（同じ曲は2回かけない）に使う */
  genre: string;
  myTags: string[];
  songId: string;
};

export type GEdge = {
  id: string;
  source: string;
  target: string;
  /** 除外条件の判定に使う（`/play` と同じ条件で繋ぎを外す） */
  difficulty: string | null;
  rating: string | null;
  practice: boolean;
};

export type PanelTransition = {
  id: string;
  otherId: string;
  otherName: string;
  /** 相手の曲の BPM。テンポが合うかは曲名の次に見るものなので、行ごとに持たせる */
  otherBpm: number | null;
  /**
   * 相手の曲から最大何曲つなげるか（`GNode.maxFrom` と同じ数）。
   * 一覧はこれが多い順に並ぶ = 先の長い枝から見える。
   */
  otherMaxFrom: number;
  fromCue: string; // 「G「助走 1サビ終受け」」形式
  toCue: string;
  comment: string;
  /** ★〜★★★★★ */
  rating: string | null;
  /** 要練習マーク（/practice に一覧が出る） */
  practice: boolean;
  /** 同時流し / ループ合わせ / カット / ビート合わせ */
  technique: string | null;
  /** TO キューの何小節「前」から。`barsAfter` とは排他（入るのは片方だけ） */
  bars: number | null;
  /** TO キューの何小節「後」から */
  barsAfter: number | null;
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
