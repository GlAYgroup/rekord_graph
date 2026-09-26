---
name: fix-tags
description: rekordbox の曲名・アーティスト・ジャンル（と My Tag の原曲分類）を決まった形式に整えて Notion 🎵Tracks まで届ける。「曲名を直して」「アーティストが違う」「ジャンルを揃えて」「タグを整えて」「表記ゆれ」「同じ曲として束ならない」に加え、**新しい曲を取り込んだ・曲を追加した・新曲を整えて**と言われたとき、および sync で「曲追加」が出たときにも必ず使う。Notion ではなく実機（master.db）を直すのが正しい流れ。
---

# fix-tags — rekordbox の曲名・アーティスト・ジャンルを直す

🎵Tracks は rekordbox の鏡なので、**直す先は実機（master.db）**。Notion を手で直しても次の sync で戻る。
実機を直す → `sync.py` が「曲更新」として 🎵Tracks に写す、が唯一の流れ。

道具は2本:

| 直すもの | スクリプト | 表 |
|---|---|---|
| 曲名・アーティスト・ジャンル | `tools/rb_tags.py` | `data/tag_fixes.json` |
| 原曲の分類（アニメ・VOCALOID…の My Tag） | `tools/rb_mytag.py --plan` | `data/mytag_plan.json` |

どちらも `data/` は個人データ（git に入れない）。

## 決まり（本人が使っている形式）

- 曲名 = `原曲タイトル（リミキサー名 remix/bootleg/edit）`。**括弧は全角**
- アーティスト = **原曲のアーティスト**（リミキサーではない）
- 曲名にジャンル名が入っていたら、ジャンル欄にも入れる
- 曲名の表記（英語 / 日本語）は**原曲のタイトル**に合わせる（`Bad Apple!!` は英語、`ローリンガール` は日本語）
- 同じ曲名の別音源は括弧で版を付けて分ける（`アンノウン・マザーグース（初音ミクver）` / `（ヒトリエver）`）
- ジャンル欄 = **音の種類**（Frenchcore・Hardcore…）。原曲の分類（アニメ・VOCALOID）は My Tag の `原曲` へ。
  ただし `Pop` / `J-Pop` / `Rock` の原曲そのものはジャンル欄に残す
- アプリは曲名の**括弧より前**で「同じ曲（リミックス違い）」を判定する。形式が崩れていると別の曲として数えられる
- **根拠のあるものだけ直す。推測で埋めない。** 根拠が無ければ空のままにして、人に聞く

未処理のチェックリストは `data/rekordbox_tag_todo.md`。

## 新しい曲を取り込んだとき

新曲は旧ファイル名のまま入ってくる（`DECO*27 - ハオ Feat. 初音ミク`、アーティストはリミキサーか空、原曲の分類なし）。
取り込みのたび（sync に「曲追加」が出たときも）に、この順で整える:

1. **洗い出す**（読むだけ。rekordbox 起動中でも可）

   ```bash
   ./.venv/bin/python tools/rb_tags.py --audit
   ```

   同期対象の曲のうち「形式から外れた曲名」「アーティストが空」「原曲の分類（My Tag）なし」を並べる。
   機械的に分かることだけで、直した後の値は出さない

2. **1曲ずつ原曲を調べる。** 旧ファイル名・リミキサー名から原曲を特定し、`WebSearch` / `WebFetch` で
   **VocaDB（ボカロ）・公式の配布ページ（SoundCloud 等）** を当たって、原曲タイトルの正式表記と原曲アーティストを確かめる。
   根拠の URL を `note` に残す。特定できない・候補が複数ある曲は推測で埋めず `status: "check"` にして人に聞く

3. **案を表にして本人に見せる**（曲ごとに: 今の曲名 → 新しい曲名 / アーティスト / ジャンル / 原曲の分類 / 根拠 / 確度）。
   了承をもらった行だけ `data/tag_fixes.json` を `status: "ok"` にし、原曲の分類は `data/mytag_plan.json` に足す
   （形は `{"id": ContentID, "title": 今の曲名, "plan": ["VOCALOID"], "conf": "◎"}`）

4. 下の「手順」の 3〜6（dry-run → rekordbox を終了 → `rb_tags.py --yes` と `rb_mytag.py --plan … --apply` → sync）

## 手順

1. **対象の ContentID を調べる**（読むだけ。rekordbox 起動中でも可）

   ```bash
   ./.venv/bin/python tools/rb_tags.py --find ハオ
   ```

   ContentID・曲名・アーティスト・ジャンルが並ぶ。**曲名ではなく ContentID で指定する**（同名曲を取り違えないため）

2. **`data/tag_fixes.json` の `entries` に足す**

   ```json
   {"id": "149146464", "current_title": "Bad Apple (Cosmowave Remix)",
    "title": "Bad Apple!!（Cosmowave remix）", "artist": "Masayoshi Minoshima feat. nomico",
    "genre": "Hardbass", "status": "ok", "note": "根拠（VocaDB の URL・旧ファイル名など）"}
   ```

   - 書かない項目は**キーごと省く**。`"genre": ""` はジャンルを空にする
   - `current_title` は今の実機の曲名（`--find` の値をそのまま）。取り違え防止の検査に使う
   - 人の判断待ちは `"status": "check"`（書かれない）。**本人に確認するまで ok にしない**
   - 反映済みの行は残してよい（差分が出ないだけ）

3. **dry-run で差分を見せ、本人の了承を取る**

   ```bash
   ./.venv/bin/python tools/rb_tags.py --dry-run
   ```

   ⚠「修正表を作った後に実機の曲名が変わっている」は、実機で別の直し方をした印。
   **実機の方が新しい判断**なので、書かずに表の `title`（と `current_title`）を実機に合わせる

4. **rekordbox を終了させて書き込む**（起動中は書き込みを拒否する。書く前に自動でバックアップを取る:
   `~/Library/Pioneer/rekordbox_backups_rekord_graph/<日時>/`）

   ```bash
   ./.venv/bin/python tools/rb_tags.py --yes
   ```

   1件ずつ判断したいときは引数なし（y/n/a/q）。`dangerouslyDisableSandbox` が要ることがある

5. **Notion に届ける** — `/sync-cues` の手順で `sync.py --dry-run` → `--yes`。
   直した曲は「曲更新」として出る。キューの差分も一緒に出るので、削除の精査は sync-cues の決まりどおりに

6. `--dry-run` を回し直して「書き込みが必要な変更はありません」になったことを確かめて報告する。
   `data/rekordbox_tag_todo.md` の該当行にチェックを付ける

## 原曲の分類（My Tag）

`data/mytag_plan.json` に人が確かめた分類を書き、足す（外しはしない）:

```bash
./.venv/bin/python tools/rb_mytag.py --plan data/mytag_plan.json          # コピーで試す
./.venv/bin/python tools/rb_mytag.py --plan data/mytag_plan.json --apply  # rekordbox を終了してから
```

`原曲` のタグは VOCALOID・アニメ・J-POP・K-POP・クラシック・東方・インターネット音楽。
書いたあとは同じく sync で 🎵Tracks の `マイタグ` 列に写る。

## やらないこと

- Notion の 🎵Tracks を手で直さない（鏡。次の sync で上書きされる）
- 曲名だけで曲を指定しない（同名曲・NFD の濁点で取り違える。ContentID を使う）
- 根拠の無いジャンル・アーティストを推測で入れない
- rekordbox 起動中に書き込まない（外から書くと壊れる）
