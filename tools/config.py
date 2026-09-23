#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ローカルツール共通の設定読み込み。

設定は **リポジトリの外** に置く（Notion の ID は人ごとに違うので、コードに書かない）。
探す順（上が優先）:

  1. 環境変数
       NOTION_TOKEN
       NOTION_DB_TRACKS / NOTION_DB_CUES / NOTION_DB_TRANSITIONS / NOTION_DB_LAYOUTS
       NOTION_DB_PLAYLISTS（任意。🎶Playlists を使うときだけ）
       REKORDBOX_FOLDER_FILTER / REKORDBOX_PRIORITY_PLAYLIST
  2. ~/.config/rekord_graph/config.json
       {
         "notion": {
           "token": "ntn_...",                      # 省略可（notion_token ファイルでもよい）
           "databases": {"tracks": "...", "cues": "...", "transitions": "...", "layouts": "...",
                         "playlists": "..."}         # playlists は任意
         },
         "rekordbox": {
           "folderFilter": "DJ_songs",              # 省略可。このパス片を含む曲だけ扱う
           "priorityPlaylist": "メイン"              # 省略可。このプレイリストの曲は必ず含める
         }
       }
  3. ~/.config/rekord_graph/notion_token（トークンだけ。1行）

Web アプリ（web/）も同じファイルを読む（ローカル開発時）。Vercel では環境変数を使う。
`tools/setup_notion.py` が Notion に DB を作り、この config.json を書き出す。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("REKORD_GRAPH_CONFIG_DIR") or Path.home() / ".config/rekord_graph")
CONFIG_FILE = CONFIG_DIR / "config.json"
TOKEN_FILE = CONFIG_DIR / "notion_token"

DB_KEYS = ("tracks", "cues", "transitions", "layouts")
# 後から足した DB。**無くても他のツール（sync など）は動く**ので、必須の検査には入れない。
# `tools/setup_notion.py --add playlists` で作る
OPTIONAL_DB_KEYS = ("playlists",)


class ConfigError(RuntimeError):
    pass


def _file() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ConfigError(f"{CONFIG_FILE} が JSON として読めません: {e}") from e


def notion_token() -> str:
    tok = os.environ.get("NOTION_TOKEN")
    if not tok:
        tok = (_file().get("notion") or {}).get("token")
    if not tok and TOKEN_FILE.exists():
        tok = TOKEN_FILE.read_text(encoding="utf-8").strip()
    if not tok:
        raise ConfigError(
            "Notion のトークンが見つかりません。\n"
            f"  環境変数 NOTION_TOKEN か、{CONFIG_FILE} の notion.token に置いてください。\n"
            "  手順は README.md の「セットアップ」を参照。"
        )
    return tok


def notion_databases(require: bool = True) -> dict[str, str]:
    """Notion の database ID（API v2022-06-28 が要求する ID。data source ID とは別物）。"""
    from_file = ((_file().get("notion") or {}).get("databases")) or {}
    out = {}
    for key in DB_KEYS:
        out[key] = os.environ.get(f"NOTION_DB_{key.upper()}") or from_file.get(key) or ""
    for key in OPTIONAL_DB_KEYS:
        found = os.environ.get(f"NOTION_DB_{key.upper()}") or from_file.get(key)
        if found:
            out[key] = found
    missing = [k for k in DB_KEYS if not out[k]]
    if require and missing:
        raise ConfigError(
            f"Notion の database ID が足りません: {', '.join(missing)}\n"
            f"  環境変数 NOTION_DB_* か、{CONFIG_FILE} の notion.databases に置いてください。\n"
            "  まだ DB が無ければ `tools/setup_notion.py` で作れます。"
        )
    return out


def rekordbox_options() -> dict[str, str | None]:
    rb = _file().get("rekordbox") or {}
    return {
        "folderFilter": os.environ.get("REKORDBOX_FOLDER_FILTER") or rb.get("folderFilter") or None,
        "priorityPlaylist": os.environ.get("REKORDBOX_PRIORITY_PLAYLIST") or rb.get("priorityPlaylist") or None,
    }


def write_config(data: dict) -> Path:
    """config.json を書く（既存があれば深くマージ）。"""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    cur = _file()
    for k, v in data.items():
        if isinstance(v, dict) and isinstance(cur.get(k), dict):
            cur[k] = {**cur[k], **v}
        else:
            cur[k] = v
    CONFIG_FILE.write_text(json.dumps(cur, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        CONFIG_FILE.chmod(0o600)  # トークンが入ることがある
    except OSError:
        pass
    return CONFIG_FILE
