/**
 * Notion から組み立てたデータの形。
 *
 * **server-only を含まない**ので client からも import できる。
 * `lib/graph.ts` は Notion アクセス（server 専用）を抱えているため、
 * 画面側のコンポーネントは型だけをこちらから取ること。
 */

export type Track = {
  id: string;
  /** 表示用。「短縮名 / rekordbox タイトル」の短縮名側を優先して出す */
  name: string;
  fullTitle: string;
  alias: string;
  artist: string;
  bpm: number | null;
  musicalKey: string;
  rekordboxId: string;
  /** 曲の長さ（秒）。タイムライン表示の比率に使う */
  durationSec: number | null;
  /**
   * 同じ曲の仲間で共通の ID（リミックス違いは同じ値になる）。`lib/song.ts` が決める。
   * 1つのプレイで同じ曲を2回かけない判定は、曲 ID ではなく**これ**で行う
   */
  songId: string;
};

export type Cue = {
  id: string;
  trackId: string;
  /** rekordbox 実機の記号。これが唯一の正（Notion のメモ由来ではない） */
  letter: string | null;
  name: string;
  positionMs: number | null;
  /**
   * rekordbox でループになっているキューか。
   * 判断の元は実機の「ループの終わり（OutMsec）が入っているか」で、キュー名ではない。
   */
  loop: boolean;
  /** ループの終わり（ms）。長さは positionMs との差。ループでなければ null */
  loopEndMs: number | null;
};

export type Transition = {
  id: string;
  fromTrackId: string;
  fromCueId: string;
  toTrackId: string;
  toCueId: string;
  comment: string;
  technique: string | null;
  /** 次の曲（To）のキューの何小節**前**から繋ぎ始めるか。`16` = To キューの16小節前 */
  bars: number | null;
  /** 次の曲（To）のキューの何小節**後**から繋ぎ始めるか。`bars` とは排他（両方は入らない） */
  barsAfter: number | null;
  rating: string | null;
  /** 要練習マーク。次の練習で拾う繋ぎに付ける（一覧は /practice） */
  practice: boolean;
  chain: string;
  order: number | null;
  needsReview: boolean;
  /** Notion が付けた作成時刻（ISO）。「新しいものが上」の並びはこれで決める */
  createdTime: string;
};

export type Graph = {
  tracks: Track[];
  trackById: Map<string, Track>;
  cueById: Map<string, Cue>;
  transitions: Transition[];
  /** 曲ID -> そこから出ていける遷移 */
  outgoing: Map<string, Transition[]>;
  /** 曲ID -> そこへ入ってこれる遷移 */
  incoming: Map<string, Transition[]>;
  /** 曲ID -> その曲のホットキュー（位置順） */
  cuesByTrack: Map<string, Cue[]>;
};
