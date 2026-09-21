# rekord_graph

DJ の「繋ぎ」を、キュー単位で記録して、プレイ中にスマホから即座に引くためのツール。

> 曲 A の **F「1サビ終受け」** から、曲 B の **C「歌入り」** の 16 小節前へ

rekordbox に打ったホットキューを Notion に鏡として写し、その上に「どのキューからどのキューへ繋ぐか」を積んでいく。
繋ぎはグラフ（曲＝点、繋ぎ＝線）とツリー、曲ごとのページから辿れる。

## できること

| 画面 | 内容 |
|---|---|
| 曲一覧 / 曲ページ | 曲のキュー一覧と、その曲から出る繋ぎ・入る繋ぎ |
| グラフ | 曲を点、繋ぎを線にした地図。配置パターンを保存して PC とスマホで同じ形を見る |
| ツリー | 選んだ曲から辿れる繋ぎを木で展開 |
| 入力 (`/new`) | From 曲を選ぶとその曲のキューがパッドで並ぶ。記号の打ち間違いが原理的に起きない |
| 練習 (`/practice`) | 「要練習」を付けた繋ぎだけの一覧 |
| パフォーマンスモード | プレイ中は編集の入口を全部畳む |

## 設計の前提: キュー名が正、アルファベットは信用しない

rekordbox でキューを編集し「メモリーキュー → ホットキュー変換」をすると、A〜P の記号は繰り下がる。
手書きのメモに残した記号は当てにならない。だからこのツールは

- 照合をキュー **UUID** で行い、作り直されたキューは **位置 (ms)** で結び直す
- 表示する記号は常に rekordbox 実機の値にする
- 繋ぎの入力はキュー名で選ばせる（記号を打たせない）

詳しい経緯は [`CLAUDE.md`](CLAUDE.md) と [`docs/PROPOSAL.md`](docs/PROPOSAL.md)。

## 仕組み

```
rekordbox (master.db)  ──rb_export.py / sync.py（自分の PC で実行）──▶  Notion
                                                                        🎵 Tracks   曲（鏡）
                                                                        📍 Cues     ホットキュー（鏡）
                                                                        🔀 Transitions 繋ぎ（人が入力）
                                                                        🗺️ Layouts  グラフの配置
                                                                              ▲
                                                Next.js アプリ（Vercel か手元）──┘
```

- `tools/` は rekordbox の DB を読む Python。**自分の PC でしか動かない**（master.db はローカルにしか無い）
- `web/` は Notion を読んで表示する Next.js。書き込むのは 🔀 Transitions と 🗺️ Layouts だけ
- Notion の ID やトークンはコードに含まれない。人ごとに `~/.config/rekord_graph/config.json` に置く

## 必要なもの

- rekordbox 6 / 7（macOS または Windows）
- Python 3.11 以上
- Node.js 20 以上と pnpm
- Notion アカウント（無料プランで可）
- 公開したいなら Vercel アカウント（任意。手元で `pnpm dev` でも使える）

## セットアップ

### 1. リポジトリを取得して Python を用意

```bash
git clone https://github.com/GlAYgroup/rekord_graph.git
cd rekord_graph
python3 -m venv .venv
./.venv/bin/pip install -r tools/requirements.txt
```

### 2. Notion の Integration を作る

1. https://www.notion.so/profile/integrations で **New integration**（Internal）を作る
2. 表示されたトークン（`ntn_...`）を **リポジトリの外** に保存する

   ```bash
   mkdir -p ~/.config/rekord_graph
   pbpaste > ~/.config/rekord_graph/notion_token   # クリップボードにコピーしてから
   chmod 600 ~/.config/rekord_graph/notion_token
   ```

3. Notion に空のページを 1 つ作る（例: 「DJ 繋ぎ」）。ページ右上 `…` →「接続」→ 作った Integration を選ぶ

### 3. Notion に DB を作る

```bash
./.venv/bin/python tools/setup_notion.py --parent "<手順 2-3 のページの URL>" --write
```

親ページの下に 🎵 Tracks / 📍 Cues / 🔀 Transitions / 🗺️ Layouts の 4 つが作られ、
その ID が `~/.config/rekord_graph/config.json` に書かれる。列名はアプリが参照するので変えない。

### 4. rekordbox のキューを流し込む

```bash
./.venv/bin/python tools/rb_export.py            # master.db を読んで data/rekordbox.json に書く
./.venv/bin/python tools/sync.py --dry-run       # Notion との差分を出す（何も書かない）
./.venv/bin/python tools/sync.py                 # 1 件ずつ y/n/a/q で承認して書く
```

初回は全曲・全キューが「追加」として出る。`a` で全部通してよい。
ライブラリの一部だけ扱いたいときは `config.json` の `rekordbox.folderFilter`（ファイルパスに含まれる文字列）と
`rekordbox.priorityPlaylist`（このプレイリストの曲は必ず含める）を設定する。

### 5. アプリを動かす

手元で:

```bash
pnpm --dir web install
pnpm --dir web dev
```

Vercel に置くなら、`web/` をルートにしてデプロイし、[`web/.env.example`](web/.env.example) の 5 つを環境変数に設定する
（値は手順 3 の出力にある）。Vercel からは rekordbox が読めないので、キューの同期は引き続き手元で行う。

## ふだんの使い方

1. rekordbox でキューを打つ・直す
2. `./.venv/bin/python tools/sync.py` で Notion に反映する（記号のズレ・ループ化・作り直しを検出して、承認した分だけ書く）
3. アプリの「入力」から繋ぎを記録する
4. プレイ中はパフォーマンスモードで開く

「状態」画面（`/health`）で、参照が壊れた繋ぎや要確認の行が分かる。

### バックアップ（iCloud Drive に同期）

```bash
./.venv/bin/python tools/backup.py            # 1回同期する
./.venv/bin/python tools/backup.py --install  # 毎日 5:00 に自動で同期する（--uninstall で止める）
```

Mac → `iCloud Drive/rekordbox-backup/` の片方向の同期。Mac が無くなっても戻せるよう、
ライブラリ（master.db・キュー・プレイリスト・波形解析・設定）と、曲が入っているフォルダ（`~/Music/DJ_songs` など）を
元の絶対パスの形のまま丸ごと置く。持つのは最新版と、ひとつ前の同期の分だけ。
rekordbox の起動中はスキップする。戻し方はスクリプト冒頭のコメント。

## 設定ファイル

`~/.config/rekord_graph/config.json`（環境変数があればそちらが優先）:

```json
{
  "notion": {
    "token": "ntn_...",
    "databases": {
      "tracks": "...", "cues": "...", "transitions": "...", "layouts": "..."
    }
  },
  "rekordbox": {
    "folderFilter": "DJ_songs",
    "priorityPlaylist": "メイン"
  }
}
```

| 環境変数 | 意味 |
|---|---|
| `NOTION_TOKEN` | Integration のトークン（`notion_token` ファイルでも可） |
| `NOTION_DB_TRACKS` / `NOTION_DB_CUES` / `NOTION_DB_TRANSITIONS` / `NOTION_DB_LAYOUTS` | 各 DB の database ID |
| `REKORDBOX_DIR` | master.db の場所（既定: macOS `~/Library/Pioneer/rekordbox`、Windows `%APPDATA%\Pioneer\rekordbox`） |
| `REKORDBOX_FOLDER_FILTER` / `REKORDBOX_PRIORITY_PLAYLIST` | `rekordbox.*` と同じ |
| `REKORD_GRAPH_CONFIG_DIR` | 設定ディレクトリを変える（既定: `~/.config/rekord_graph`） |

## ディレクトリ

```
tools/   rekordbox → Notion の同期（ローカル実行）
web/     Next.js アプリ
data/    rekordbox の書き出しなど生成物（git には入れない）
docs/    設計メモ
```

## 注意

- 🎵 Tracks と 📍 Cues は機械が管理する鏡。Notion 側で手編集しても次の同期で上書きされる。直すのは rekordbox 側
- master.db への書き込みは `tools/rb_retitle.py`（曲名の一括修正）だけで、実行前にバックアップを取る。Pioneer 非公式なので自己責任
- `tools/migrate_transitions.py` は作者の手書きメモを取り込んだ一回きりのツール。参考実装として置いてある

## ライセンス

[MIT](LICENSE)
