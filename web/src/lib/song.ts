/**
 * 「同じ曲か」を決める。**リミックス違いは同じ曲として扱う。**
 *
 * 1つのプレイの中で同じ曲を2回かけないのは、ファイルが同じときだけではない。
 * `フォニイ（6Tan bootleg）` と `フォニイ（KOHaq remix）` は別の曲ファイルだが、
 * 客から見れば同じ曲なので、片方をかけたらもう片方もそのセットでは使えない。
 *
 * 判断の元は **rekordbox の曲名**（実機が正）。曲名は
 * `原曲タイトル（リミキサー名 remix/bootleg/edit）` の形で整えてあるので、
 * **括弧より前 = 原曲タイトル**で束ねる。
 *
 * 推測で広げない: 部分一致や別名では束ねない（`DECO*27` のような接頭辞で
 * 別の曲同士がくっつく）。形の崩れた曲名は束ねられずに別の曲として残るので、
 * rekordbox 側で曲名を整えて直す（Notion の 🎵Tracks は鏡なので sync が運ぶ）。
 *
 * server-only を含まないので client（/play）からも使える。
 */

/** 🎵Tracks の曲名は「別名 / rekordbox の原題」。原題側だけを取り出す */
function rekordboxTitle(fullTitle: string, alias: string): string {
  const prefix = `${alias} / `;
  return alias && fullTitle.startsWith(prefix) ? fullTitle.slice(prefix.length) : fullTitle;
}

/**
 * 原曲タイトルを比べられる形にしたもの。空になったら null（束ねようがない）。
 * NFKC・空白除去・小文字化はキュー名の照合と同じ考え方（表記の揺れで別物にしない）。
 */
function songKey(title: string): string | null {
  let s = title.normalize("NFKC")
    .replace(/【[^】]*】/g, " ")        // 【KAFU】などの歌唱者・配布表記
    .replace(/^\s*\[[^\]]*\]/, " ")     // 先頭の [IA, VY2] のような歌唱者表記
    .split(/[([（［]/)[0];              // 括弧より前 = 原曲タイトル
  // 「アーティスト - 曲名」の形は後ろが曲名（両側に空白があるハイフンだけ）
  const parts = s.split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) s = parts[parts.length - 1];
  s = s.replace(/\s*(feat\.|ft\.).*$/i, "").replace(/\s+/g, "").toLowerCase();
  return s || null;
}

/**
 * 曲ID -> 同じ曲の仲間で共通の ID（`song:<原曲タイトル>`）。
 * 原曲タイトルが取れない曲は、自分の曲 ID をそのまま使う（＝誰とも束ねない）。
 */
export function songIdOf(t: { id: string; fullTitle: string; alias: string }): string {
  const key = songKey(rekordboxTitle(t.fullTitle, t.alias));
  return key ? `song:${key}` : t.id;
}
