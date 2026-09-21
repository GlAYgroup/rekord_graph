#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Notion に rekord_graph 用の 4 つの DB を作り、設定ファイルを書く（初回だけ）。

    ./.venv/bin/python tools/setup_notion.py --parent <Notion ページの URL or ID>
    ./.venv/bin/python tools/setup_notion.py --parent <...> --write   # ~/.config/rekord_graph/config.json に書く

前提:
  - Notion の Integration（内部インテグレーション）を作り、トークン（ntn_...）を
    環境変数 NOTION_TOKEN か ~/.config/rekord_graph/notion_token に置いてある
  - 親にするページを 1 つ作り、そのページを Integration に接続してある
    （ページ右上「…」→「接続」→ 作った Integration）。子として作られる DB は自動で見える

作る DB（列名はアプリ・sync が参照するので変えない）:
  🎵 Tracks      曲。rekordbox の鏡（sync.py が書く）
  📍 Cues        ホットキュー。rekordbox の鏡（sync.py が書く）
  🔀 Transitions 繋ぎ。人が入力する唯一の DB（アプリの /new から）
  🗺️ Layouts     グラフの配置パターン（アプリが書く）
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import config
import notion_api as na

HOTCUE_LETTERS = "ABCDEFGHIJKLMNOP"
RATINGS = ["★", "★★", "★★★", "★★★★", "★★★★★"]           # web/src/lib/ratings.ts と同じ
DIFFICULTIES = ["Easy", "Middle", "Hard"]                  # web/src/lib/difficulty.ts と同じ
TECHNIQUES = ["同時流し", "ループ合わせ", "カット", "ビート合わせ"]  # web/src/components/TransitionForm.tsx と同じ


def title(): return {"title": {}}
def text(): return {"rich_text": {}}
def number(): return {"number": {"format": "number"}}
def checkbox(): return {"checkbox": {}}
def select(options): return {"select": {"options": [{"name": o} for o in options]}}
def relation(db_id): return {"relation": {"database_id": db_id, "single_property": {}}}


def schema_tracks() -> dict:
    return {
        "曲名": title(),
        "別名": text(),
        "rekordboxID": text(),   # 正準ID（rekordbox の ContentID）
        "アーティスト": text(),
        "ジャンル": text(),      # 実機のジャンル欄。分類は rekordbox 側で行う
        "マイタグ": text(),      # 実機の My Tag。1行に「カテゴリ/タグ」（原曲/アニメ）
        "BPM": number(),
        "Key": text(),
        "長さ秒": number(),
        "ファイルパス": text(),
    }


def schema_cues(tracks_id: str) -> dict:
    return {
        "キュー": title(),        # 「短縮名 / 記号「キュー名」」。リレーション選択の絞り込み用
        "曲": relation(tracks_id),
        "記号": select(list(HOTCUE_LETTERS)),
        "キュー名": text(),       # ★ 唯一の正準情報（アルファベットは信用しない）
        "位置": text(),
        "位置ms": number(),
        "種別": select(["Hot"]),
        "ループ": checkbox(),
        "ループ終ms": number(),
        "cueUUID": text(),       # 正準ID（rekordbox のキュー UUID）
    }


def schema_transitions(tracks_id: str, cues_id: str) -> dict:
    return {
        "つなぎ": title(),
        "From曲": relation(tracks_id),
        "Fromキュー": relation(cues_id),
        "To曲": relation(tracks_id),
        "Toキュー": relation(cues_id),
        "コメント": text(),
        "チェーン": text(),
        "順番": number(),
        "種類": select(TECHNIQUES),
        "評価": select(RATINGS),
        "難易度": select(DIFFICULTIES),  # /play の「◯まで」で難しい繋ぎを外すのに使う
        "小節数": number(),          # 次の曲（To）のキューの何小節「前」から繋ぎ始めるか
        "小節数（後）": number(),     # 同じく何小節「後」から。小節数とは排他（入るのは片方だけ）
        "要練習": checkbox(),
        "同期ステータス": select(["OK", "要確認"]),
        "出典": text(),          # どこから来た行か（アプリ / 移行 など）
    }


def schema_layouts() -> dict:
    return {"名前": title(), "配置": text(), "曲数": number()}


def parse_page_id(s: str) -> str:
    """URL でも ID でも受ける。末尾の 32 桁 hex を拾ってハイフン区切りにする。"""
    m = re.findall(r"[0-9a-fA-F]{32}", s.replace("-", ""))
    if not m:
        raise SystemExit(f"Notion のページ ID が読み取れません: {s}")
    h = m[-1].lower()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def create_db(parent: str, name: str, emoji: str, props: dict) -> str:
    res = na.request("POST", "/databases", {
        "parent": {"type": "page_id", "page_id": parent},
        "icon": {"type": "emoji", "emoji": emoji},
        "title": [{"type": "text", "text": {"content": name}}],
        "properties": props,
    })
    print(f"  作成: {emoji} {name}  {res['id']}")
    return res["id"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--parent", required=True, help="DB を作る親ページの URL か ID（Integration に接続済みであること）")
    ap.add_argument("--write", action="store_true", help=f"{config.CONFIG_FILE} に database ID を書く")
    ap.add_argument("--force", action="store_true", help="設定に database ID が既にあっても作る")
    args = ap.parse_args()

    existing = config.notion_databases(require=False)
    if any(existing.values()) and not args.force:
        print("設定に database ID が既にあります。作り直すなら --force を付けてください:", file=sys.stderr)
        print(json.dumps(existing, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2

    parent = parse_page_id(args.parent)
    try:
        page = na.request("GET", f"/pages/{parent}")
    except na.NotionError as e:
        print(f"親ページが読めません。ページを Integration に接続したか確認してください。\n{e}", file=sys.stderr)
        return 1
    ptitle = "".join(t.get("plain_text", "") for t in (page.get("properties", {}).get("title", {}).get("title") or []))
    print(f"親ページ: {ptitle or parent}")

    tracks = create_db(parent, "Tracks", "🎵", schema_tracks())
    cues = create_db(parent, "Cues", "📍", schema_cues(tracks))
    transitions = create_db(parent, "Transitions", "🔀", schema_transitions(tracks, cues))
    layouts = create_db(parent, "Layouts", "🗺️", schema_layouts())
    dbs = {"tracks": tracks, "cues": cues, "transitions": transitions, "layouts": layouts}

    print()
    if args.write:
        path = config.write_config({"notion": {"databases": dbs}})
        print(f"書きました: {path}")
    else:
        print(f"次の内容を {config.CONFIG_FILE} に書いてください（--write で自動で書けます）:")
        print(json.dumps({"notion": {"databases": dbs}}, ensure_ascii=False, indent=2))
    print()
    print("Vercel に置く場合の環境変数:")
    for k, v in dbs.items():
        print(f"  NOTION_DB_{k.upper()}={v}")
    print()
    print("次は rekordbox のキューを流し込みます:")
    print("  ./.venv/bin/python tools/rb_export.py && ./.venv/bin/python tools/sync.py --dry-run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
