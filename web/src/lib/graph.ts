import "server-only";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { DB, dbGeneration, dbTag, NOTION_TAG, num, queryAll, relIds, REVALIDATE_SECONDS, selectName, text, type NotionPage } from "./notion";
import { songIdOf } from "./song";

/**
 * Notion の3つの DB を、たどれるグラフに組み立てる。
 *
 * ノード = 曲、エッジ = トランジション。
 * 正準IDは rekordbox 側の ID / UUID（Notion のページIDではない）だが、
 * 画面では Notion のページIDをそのまま URL に使う（短くて安定しているため）。
 */

// データの形は client からも参照するので lib/types.ts に置く
export type { Cue, Graph, Track, Transition } from "./types";
import type { Cue, Graph, Track, Transition } from "./types";

/**
 * 曲の表示名 = **「曲名 (リミックス)」** の形に整える。
 *
 * rekordbox の原題はファイル名由来で、そのまま出すと読めない:
 *   `かいりきベア feat.flower - ベノム (Gakui Bootleg)`
 *   `NOHSHOH_SAKURETSU_GIRL_(Marble_Remix)_final_v2`
 * DJ 中に要るのは「どの曲か」と「どのリミックスか」の2つだけなので、そこだけ残す:
 *   `ベノム (Gakui Bootleg)` / `脳漿炸裂ガール (Marble Remix)`
 *
 * 原題は `fullTitle` に残してあり、検索はそちらも含めて引っかかる。
 */

/** リミックスかどうかの手掛かりになる語。これを含む括弧を優先する */
const REMIX_WORDS = /(remix|bootleg|edit|flip|mix|vip|mashup|rework)/i;

/**
 * リミックス名を拾う。
 * 括弧が複数あるとき（`(Reloaded) [DAYOx2 UK Hardcore Bootleg)`）は
 * **Remix / Bootleg 等を含む方**を選ぶ。原曲のバージョン表記を掴まないため。
 */
function remixTag(title: string): string {
  const clean = (x: string) => x.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  const groups = [...title.matchAll(/[([（［【]([^)\]）］】]*)[)\]）］】]/g)]
    .map((m) => clean(m[1]))
    .filter((g) => g && !/^(ft\.|feat\.)/i.test(g) && !/^[\d.\s]+$/.test(g));

  const keyed = groups.find((g) => REMIX_WORDS.test(g));
  if (keyed) return keyed;
  if (groups.length) return groups[0];

  // 括弧が無い形（`Vampire KCHACK Bootleg` / `..._Wipecore_VIP_Remix_v3`）。
  // Remix 等の語と、その手前の1語だけを拾う（2語まで見ると曲名まで巻き込む）
  const m = clean(title).match(/([^\s]+\s+(?:remix|bootleg|edit|flip|vip|mix))\b/i);
  return m ? m[1] : "";
}

/** 曲名側。別名があればそれが正。無ければ原題から装飾を削る */
function songName(title: string, alias: string): string {
  if (alias) return alias;
  let s = title
    .replace(/【[^】]*】/g, " ")   // 【KAFU】などの歌唱者表記
    .split(/[([（［]/)[0]           // 括弧より前
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 「アーティスト - 曲名」の形は後ろが曲名。
  // ハイフンの両側に空白がある場合だけ切る（`2-27` や `-Dead End-` を壊さない）
  const parts = s.split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) s = parts[parts.length - 1];
  s = s.replace(/\s*(feat\.|ft\.).*$/i, "").trim();
  return s || title;
}

/**
 * 🎵Tracks の曲名列から rekordbox の原題を取り出す。sync は短縮名が原題と違う曲を
 * 「短縮名 / 原題」の形で書く（`tools/sync.py` の `_track_title`）。
 * リミックス名は**原題の側から**拾う — 短縮名の括弧まで拾うと、
 * `六兆年と一夜物語(master) / 六兆年と一夜物語（master weiss HASS）` が `master` だけになる
 */
function rekordboxTitle(title: string, alias: string): string {
  const head = `${alias} / `;
  return alias && title.startsWith(head) ? title.slice(head.length) : title;
}

/**
 * 別名（= sync が作る短縮名）の末尾の識別子 `(…)` を外す。外せるときだけ。
 *
 * 短縮名は、同じ曲名が複数あるときだけ `フォニイ(6Tan)` のように識別子を付けて一意にしてある
 * （📍Cues でどの曲のキューか見分けるため。向こうでは外せない。
 * `tools/gen_cue_payload.py` の `build_short_names`）。識別子はリミックス名から取った語なので、
 * そのままリミックス名を足すと `フォニイ(6Tan) (6Tan bootleg)` と二重になっていた（41曲）。
 * **識別子の語が全部リミックス名に入っているときだけ**外す（足すリミックス名で見分けが付く）
 */
function withoutShortNameTag(alias: string, tag: string): string {
  const m = alias.match(/^(.+?)\(([^()]+)\)$/);
  if (!m || !tag) return alias;
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/_/g, " ");
  const hay = norm(tag);
  return norm(m[2]).split(/\s+/).filter(Boolean).every((w) => hay.includes(w)) ? m[1].trim() : alias;
}

function displayName(title: string, alias: string): string {
  const original = rekordboxTitle(title, alias);
  let tag = remixTag(original);
  const base = songName(original, withoutShortNameTag(alias, tag));
  // 曲名がそのままリミックス名に混ざることがある（`テトリス Wipecore VIP`）。落とす
  if (tag && base) {
    tag = tag.replace(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "").trim();
  }
  return tag && !base.toLowerCase().includes(tag.toLowerCase()) ? `${base} (${tag})` : base;
}

/**
 * 同じ表示名になってしまった曲を区別する。
 * `フォニイ / phony` と `フォニイ / foni_0db` のように、原題が違うのに
 * 整えると同じ名前になる曲が実在する。地図の上で見分けが付かないのは致命的なので、
 * 衝突したものにだけ原題の残りを足す（衝突していないものは短いまま）。
 */
function disambiguate<T extends { name: string; fullTitle: string; alias: string }>(tracks: T[]): void {
  const count = new Map<string, number>();
  for (const t of tracks) count.set(t.name, (count.get(t.name) ?? 0) + 1);
  for (const t of tracks) {
    if ((count.get(t.name) ?? 0) < 2) continue;
    const rest = t.fullTitle
      .replace(t.alias, "")
      .replace(/^\s*\/\s*/, "")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (rest) t.name = `${t.name} (${rest.slice(0, 20)})`;
  }
}

/**
 * 読み取りキャッシュの形の版。下の `parse*` が返す形を変えたら上げる
 * （キャッシュはデプロイをまたいで残るので、上げないと新しいコードが古い形を受け取る）
 */
const SHAPE = "v2";

/**
 * DB 1つを「読んで整えた結果」ごと1件でキャッシュする。
 *
 * 以前は Notion の生の応答を**ページ（100行）ごとに**キャッシュしていたので、画面を開くたびに
 * 📍Cues だけで32回、全体で約40回キャッシュを順番に読んでいた（Notion の続きのページは前のページの
 * カーソルが要るので並べられない）。本番では1回ごとにキャッシュまでの往復が乗り、
 * 中身の計算は手元で 0.05〜0.08 秒なのに、どの画面も約0.8〜1秒かかっていた（実測 2026-10-04）。
 * いまは DB ごとに1件 = 3件を並べて読む。
 *
 * 中の読み込みは `fresh`（Notion を直接読む）。キャッシュを二重に持つと、外側を作り直したときに
 * 内側の古いページを掴み、反映が最大で倍（10分）遅れるため。期限と捨て方（`dbTag`）は今まで通り:
 * アプリが繋ぎを書いたら 🔀Transitions の分だけ捨て、🎵Tracks・📍Cues は5分で拾う
 */
const reading = new Map<string, Promise<NotionPage[]>>();
/**
 * キャッシュが空のときに画面が一斉に来ても、Notion を読むのは1本にまとめる
 * （`fresh` の読み込みは notion.ts のまとめ役を通らない。並ぶと Notion の上限に当たる）
 */
function readOnce(dbId: string): Promise<NotionPage[]> {
  // 鍵に「書いた回数」（`dbGeneration`）を混ぜる。混ぜないと、書く前に始まった読み込みを
  // 書いた後の画面も受け取り、その古い中身が `unstable_cache` に新しいものとして最大5分残る。
  // 回数はこのサーバのインスタンスの中だけ（notion.ts の `invalidateDb` を参照）
  const key = `${dbId}#${dbGeneration(dbId)}`;
  const running = reading.get(key);
  if (running) return running;
  const p = queryAll(dbId, true).finally(() => reading.delete(key));
  reading.set(key, p);
  return p;
}

function cachedDb<T>(name: string, dbId: string, parse: (pages: NotionPage[]) => T): Promise<T> {
  return unstable_cache(
    async () => parse(await readOnce(dbId)),
    ["graph", name, SHAPE, dbId],
    { revalidate: REVALIDATE_SECONDS, tags: [NOTION_TAG, dbTag(dbId)] },
  )();
}

async function build(): Promise<Graph> {
  const [tracks, cues, transitions] = await Promise.all([
    cachedDb("tracks", DB.tracks, parseTracks),
    cachedDb("cues", DB.cues, parseCues),
    cachedDb("transitions", DB.transitions, parseTransitions),
  ]);
  return assemble(tracks, cues, transitions);
}

function parseTracks(trackPages: NotionPage[]): Track[] {
  const tracks: Track[] = trackPages.map((p) => {
    const title = text(p.properties["曲名"]);
    const alias = text(p.properties["別名"]);
    return {
      id: p.id,
      name: displayName(title, alias),
      fullTitle: title,
      alias,
      artist: text(p.properties["アーティスト"]),
      // 列は sync が生やす。まだ無いワークスペースでは空（= どのジャンル条件でも外さない）
      genre: text(p.properties["ジャンル"]).trim(),
      // 1行に1つ（sync が書く形）。列が無ければ空
      myTags: text(p.properties["マイタグ"]).split("\n").map((s) => s.trim()).filter((s) => s.includes("/")),
      bpm: num(p.properties["BPM"]),
      musicalKey: text(p.properties["Key"]),
      rekordboxId: text(p.properties["rekordboxID"]),
      durationSec: num(p.properties["長さ秒"]),
      songId: songIdOf({ id: p.id, fullTitle: title, alias }),
    };
  });
  disambiguate(tracks);
  tracks.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return tracks;
}

function parseCues(cuePages: NotionPage[]): Cue[] {
  return cuePages.map((p) => ({
    id: p.id,
    trackId: relIds(p.properties["曲"])[0] ?? "",
    letter: selectName(p.properties["記号"]),
    name: text(p.properties["キュー名"]),
    positionMs: num(p.properties["位置ms"]),
    // 📍Cues にループ列がまだ無いワークスペースでも動く（無ければ「ループではない」）。
    // 列を生やして値を入れるのは `tools/sync.py` の仕事
    loop: p.properties["ループ"]?.checkbox ?? false,
    loopEndMs: num(p.properties["ループ終ms"]),
  }));
}

function parseTransitions(transitionPages: NotionPage[]): Transition[] {
  return transitionPages
    .map((p) => ({
      id: p.id,
      fromTrackId: relIds(p.properties["From曲"])[0] ?? "",
      fromCueId: relIds(p.properties["Fromキュー"])[0] ?? "",
      toTrackId: relIds(p.properties["To曲"])[0] ?? "",
      toCueId: relIds(p.properties["Toキュー"])[0] ?? "",
      comment: text(p.properties["コメント"]),
      technique: selectName(p.properties["種類"]),
      bars: num(p.properties["小節数"]),
      // 「小節数（後）」列がまだ無いワークスペースでも動く（無ければ「後は未入力」）。
      // 列は最初に「後」を書いたときにアプリが生やす（`lib/transitions.ts`）
      barsAfter: num(p.properties["小節数（後）"]),
      // ループ合わせの小節数。列がまだ無いワークスペースでも動く（最初の保存でアプリが生やす）
      loopBefore: num(p.properties["ループ小節（繋ぎ前）"]),
      loopAfter: num(p.properties["ループ小節（繋ぎ後）"]),
      rating: selectName(p.properties["評価"]),
      // 「難易度」列がまだ無いワークスペースでも動く（無ければ未入力）
      difficulty: selectName(p.properties["難易度"]),
      // 「要練習」列がまだ無いワークスペースでも動く（無ければ「マークなし」）。
      // 列は最初にマークを付けたときにアプリが生やす（`lib/transitions.ts`）
      practice: p.properties["要練習"]?.checkbox ?? false,
      chain: text(p.properties["チェーン"]),
      order: num(p.properties["順番"]),
      needsReview: selectName(p.properties["同期ステータス"]) === "要確認",
      createdTime: p.created_time ?? "",
    }))
    // 曲が両方埋まっていない行は、書きかけとみなして地図に載せない。
    // キューは空でよい（曲とメモだけで残した繋ぎ。表示は `cueOf` が「キュー未定」にする）
    .filter((t) => t.fromTrackId && t.toTrackId);
}

/** 整えた3つを、たどれる形（引き口の Map）に組む。Map はキャッシュに入らないので毎回ここで作る */
function assemble(tracks: Track[], cues: Cue[], transitions: Transition[]): Graph {
  const cuesByTrack = new Map<string, Cue[]>();
  for (const c of cues) {
    if (!c.trackId) continue;
    (cuesByTrack.get(c.trackId) ?? cuesByTrack.set(c.trackId, []).get(c.trackId)!).push(c);
  }
  for (const list of cuesByTrack.values()) {
    list.sort((a, b) => (a.positionMs ?? 0) - (b.positionMs ?? 0));
  }

  const outgoing = new Map<string, Transition[]>();
  const incoming = new Map<string, Transition[]>();
  for (const t of transitions) {
    (outgoing.get(t.fromTrackId) ?? outgoing.set(t.fromTrackId, []).get(t.fromTrackId)!).push(t);
    (incoming.get(t.toTrackId) ?? incoming.set(t.toTrackId, []).get(t.toTrackId)!).push(t);
  }

  return {
    tracks,
    trackById: new Map(tracks.map((t) => [t.id, t])),
    cueById: new Map(cues.map((c) => [c.id, c])),
    transitions,
    outgoing,
    incoming,
    cuesByTrack,
  };
}

/** 1リクエスト内で何度呼んでも Notion を1回しか叩かない。 */
export const getGraph = cache(build);

// 表示用の変換は client からも使うので lib/format.ts に置く。ここは再輸出だけ
export { bpmDelta, formatPosition } from "./format";
