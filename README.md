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
./.venv/bin/python tools/sync.py --dry-run       # master.db を読んで Notion との差分を出す（何も書かない）
./.venv/bin/python tools/sync.py                 # 1 件ずつ y/n/a/q で承認して書く
```

初回は全曲・全キューが「追加」として出る。`a` で全部通してよい。
ライブラリの一部だけ扱いたいときは `config.json` の `rekordbox.scopePlaylists`（このプレイリスト/フォルダ配下の曲だけ。
フォルダは中を全部たどる。`フォルダ/プレイリスト` とも書ける）を設定する。名前が見つからなければ sync は止まる。
プレイリストから外した曲は「消えた曲」とは区別され、Notion から消えない。
古い絞り込み `rekordbox.folderFilter`（ファイルパスに含まれる文字列）と
`rekordbox.priorityPlaylist`（このプレイリストの曲は必ず含める）も使える（`scopePlaylists` があれば `folderFilter` は使わない）。

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

参照が壊れた繋ぎ（From曲/To曲 が空・消えた曲やキューを指している）と `同期ステータス = 要確認` の行は、
`tools/sync.py`（`--dry-run` でも）が最後に「🔀Transitions の要確認」として毎回出す。sync は読むだけで直さないので、
アプリの編集（`/new?edit=`）か Notion で直す（「状態」画面は 2026-10-04 に外した）。

### イベントのプレイリストを rekordbox に書き出す

アプリの「プレイリスト」（`/playlists`。Notion の 🎶Playlists）で作ったものを rekordbox に作る。
rekordbox の `rekord_graph` フォルダの中だけを触り、同じ名前があれば中身を入れ替える（番号 = アプリの並び順）。

```bash
./.venv/bin/python tools/rb_playlist.py          # 何が変わるかを見るだけ
./.venv/bin/python tools/rb_playlist.py --apply  # rekordbox を終了してから
./.venv/bin/python tools/rb_playlist.py --import "ボカトト" --apply  # 逆向き: rekordbox のプレイリストをアプリへ
```

🎶Playlists の DB は後から足したもの。無ければ `./.venv/bin/python tools/setup_notion.py --add playlists --write` で
今ある DB と同じページに作る（Vercel には `NOTION_DB_PLAYLISTS` を足す）。

### バックアップ（Google Driveへ直接送信）

初回に`brew install rclone`を実行し、`rclone config`でGoogle Driveのremote
`rekordbox-gdrive`を作る。Googleのログイン・OAuth認可は本人が操作する
継続運用には[専用OAuthクライアント](https://rclone.org/drive/#making-your-own-client-id)を設定する（共有クライアントは2026年に廃止）
バックアップ専用なら`drive.file`スコープでrcloneが作成したファイルだけにアクセスできる
My Driveの専用フォルダを使い、共有設定は追加しない

```bash
rclone about rekordbox-gdrive:                 # 実際の空き容量を確認
./.venv/bin/python tools/backup.py --remote rekordbox-gdrive:other/rekordbox-backup --dry-run
./.venv/bin/python tools/backup.py --remote rekordbox-gdrive:other/rekordbox-backup
./.venv/bin/python tools/backup.py --remote rekordbox-gdrive:other/rekordbox-backup --verify
./.venv/bin/python tools/backup.py --remote rekordbox-gdrive:other/rekordbox-backup --install
```

Mac → Google Driveの`other/rekordbox-backup/`への片方向同期。Macが無くなっても戻せるよう、
ライブラリ（master.db・キュー・プレイリスト・波形解析・設定）と、曲が入っているフォルダ（`~/Music/DJ_songs` など）を
元の絶対パスの形で丸ごと置く。`library/latest`は最新版、`library/previous`は前回のライブラリ、
`files`は現在の曲、`previous/files`は前回の同期で上書き・削除された曲
曲をローカルに複製せず、ライブラリと設定だけ一時コピーする（約480MB、別途1GiBの余裕が必要）
作業用コピーと実行ロックはリポジトリ内の`.backup-state/`に置く（git対象外）
macOSの定期清掃で古い更新時刻の解析ファイルが消えないよう、OSの一時領域は使わない
rekordboxの起動中はスキップし、曲とライブラリの転送・照合が成功してから世代を更新する
ライブラリの作業用世代`library/.stage`を再利用して差分同期する（初期の世代作成時は全量送信）
`.stage`は未完成なので復元には使わない。照合済みの世代は一時的に`.verified`となり、
中断後は次回実行で世代更新を完了させてから新しい同期を始める
`--verify`はDBが参照する曲をNFC正規化したパスとサイズで照合し、欠けや重複をエラーにする
macOSでは大文字・小文字だけが違う参照も同じファイルとして照合する

`--install`はrcloneの絶対パスをlaunchdに保存し、毎日5:00に実行する
ログは`~/Library/Logs/rekord_graph_backup.log`、停止は`--uninstall`
手動で試すには`launchctl kickstart gui/$(id -u)/com.rekord-graph.backup`

既存のローカル/iCloud経路も使える。`--remote`を省略すると従来のiCloud保存先、
`--dest`または`REKORD_GRAPH_BACKUP_DIR`でローカル保存先を変更できる
移行先の転送と照合が完了するまで、iCloudのバックアップと自動実行設定は残す

戻し方は、新しいMacにrekordboxを入れて一度起動し、終了してから以下を行う

1. rcloneをインストールし、同じGoogleアカウントを認可する。`drive.file`は[アプリごとのファイルアクセス](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)なので、バックアップ作成時と同じOAuthクライアントを使う。OAuth設定を復旧できない場合は、Google DriveのWeb画面から`other`内の`rekordbox-backup`フォルダをダウンロードする
2. `rclone copy rekordbox-gdrive:other/rekordbox-backup ~/rekordbox-restore`で取得する（全容量の空きが必要）
3. 取得した`library/latest/rekordbox/`を`~/Library/Pioneer/rekordbox/`へ戻す
4. `library/latest/settings/`を`~/Library/Application Support/Pioneer/rekordbox6/`へ戻す
5. `files/`の中身を元の絶対パスへ戻す。ユーザー名が違う場合は`files/Users/<元ユーザー>/Music/`を新しい`~/Music/`へ戻し、rekordboxの「再配置」で直す
6. `library/latest/rekord_graph/`をこのリポジトリの`data/`へ戻し、rekordboxを起動する

USBの`exportLibrary.db`はrekordboxのデバイスへのエクスポートで作り直せる
失敗時の退避は`.incomplete/<実行ID>/`に保持する。確認前に削除しない
`library/latest`が無い場合は照合済みの`library/.verified`、それも無ければ`library/previous`を使う
前回の世代を戻す場合は`previous/files`の曲ファイルを`files`より優先して同じパスへ戻す
必要なら`previous/files`や失敗した実行の`.incomplete/<実行ID>/files`から以前の曲を戻す

## 設定ファイル

`~/.config/rekord_graph/config.json`（環境変数があればそちらが優先）:

```json
{
  "notion": {
    "token": "ntn_...",
    "databases": {
      "tracks": "...", "cues": "...", "transitions": "...", "layouts": "...",
      "playlists": "..."
    }
  },
  "rekordbox": {
    "scopePlaylists": ["vocalo", "Anime", "classic"]
  }
}
```

| 環境変数 | 意味 |
|---|---|
| `NOTION_TOKEN` | Integration のトークン（`notion_token` ファイルでも可） |
| `NOTION_DB_TRACKS` / `NOTION_DB_CUES` / `NOTION_DB_TRANSITIONS` / `NOTION_DB_LAYOUTS` | 各 DB の database ID |
| `NOTION_DB_PLAYLISTS` | 🎶Playlists の database ID（任意。無ければプレイリストの画面だけが「未設定」） |
| `REKORDBOX_DIR` | master.db の場所（既定: macOS `~/Library/Pioneer/rekordbox`、Windows `%APPDATA%\Pioneer\rekordbox`） |
| `REKORDBOX_SCOPE_PLAYLISTS` | `rekordbox.scopePlaylists` と同じ（カンマ区切り） |
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
- master.db へ書き込むのは `tools/rb_tags.py`（曲名・アーティスト・ジャンル）・`tools/rb_mytag.py`（My Tag）・`tools/rb_playlist.py`（プレイリスト）・`tools/rb_cue_color.py`（キューの色）。rekordbox を終了してから回す。
  どれも `tools/rb_db.py` を通り、rekordbox が起動中なら止め（書く前と commit の直前の2回見る）、書く前に
  `~/Library/Pioneer/rekordbox_backups_rekord_graph/<日時>/` へ master.db を丸ごとバックアップする。
  master.db の場所は全ツール共通で `REKORDBOX_DIR`。読むだけのときはコピーを `<一時ディレクトリ>/rekord_graph/` に作り、
  新しい2つだけ残して古いものは自動で消す。Pioneer 非公式なので自己責任
- `tools/migrate_transitions.py` は作者の手書きメモを取り込んだ一回きりのツール。参考実装として置いてある

## ライセンス

[MIT](LICENSE)
