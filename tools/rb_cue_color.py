#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rekordbox のキューの色を、キュー名で選んでまとめて黄色にする（ホットキューもメモリーキューも）。

    ./.venv/bin/python tools/rb_cue_color.py --names 1サビ終,2歌入り --dry-run   # 出すだけ。何も書かない
    ./.venv/bin/python tools/rb_cue_color.py --names 1サビ終,2歌入り --yes       # 書く（rekordbox を終了してから）

- 名前は**完全一致**（NFKC・空白を除いて比べる。`'1サビ終 '` は `1サビ終` と同じ）。
  `ラス受け2` を入れたいときは `ラス受け2` も名前に並べる（部分一致はしない = 思わぬキューを塗らない）
- 対象は sync と同じ範囲（`rekordbox.scopePlaylists`）の曲だけ。`--all` でライブラリ全体
- 既に黄色のキューは書かない（二度流しても差分が出ないだけ）

色の値は、本人が rekordbox で黄色にしたキュー（「コノハの世界事情」1サビ終・2歌入り・ラス受け、2026-10-03）から写した:
  ホットキュー  = Color 255 + ColorTableIndex 32（ホットキューの色は ColorTableIndex で決まる。255 は「表を見る」の印）
  メモリーキュー = Color 3（メモリーキューの色は Color の番号。ColorTableIndex は使わない）

master.db への直接書き込みは Pioneer 非公式なので、`rb_tags.py` と同じく安全側に倒す:
- 書き込み前に master.db / -wal / -shm を丸ごとバックアップする（必須・スキップ不可）
- rekordbox が起動中なら書き込みを拒否する（--dry-run はコピーを読むので可）
- 書いたあと読み直して、全部が黄色になったかを確かめる
"""
from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import rb_export  # noqa: E402
from rb_tags import backup, open_db, rekordbox_running  # noqa: E402

HOT_YELLOW = (255, 32)  # (Color, ColorTableIndex)
MEMORY_YELLOW = 3       # Color


def norm(s: str | None) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s or ""))


def is_yellow(c) -> bool:
    if c.Kind:
        return (c.Color, c.ColorTableIndex) == HOT_YELLOW
    return c.Color == MEMORY_YELLOW


def build_plan(db, names: set[str], everywhere: bool) -> dict[str, list]:
    """曲ID -> 黄色にするキュー（位置順）。"""
    scope = None
    if not everywhere:
        opts = config.rekordbox_options()
        if opts["scopePlaylists"]:
            scope = rb_export.scope_track_ids(db.get_playlist().all(), db.get_playlist_contents, opts["scopePlaylists"])
    plan: dict[str, list] = defaultdict(list)
    for c in db.get_cue():
        if norm(c.Comment) not in names or is_yellow(c):
            continue
        if scope is not None and str(c.ContentID) not in scope:
            continue
        plan[str(c.ContentID)].append(c)
    for cues in plan.values():
        cues.sort(key=lambda c: (c.InMsec or 0, c.Kind == 0))
    return plan


def show(db, plan: dict[str, list]) -> None:
    for i, (tid, cues) in enumerate(sorted(plan.items(), key=lambda x: (db.get_content(ID=x[0]).Title or "")), 1):
        print(f"[{i}/{len(plan)}] {db.get_content(ID=tid).Title}")
        for c in cues:
            kind = "ホット " if c.Kind else "メモリー"
            before = f"{c.Color}/{c.ColorTableIndex}" if c.Kind else f"{c.Color}"
            print(f"    {kind} {(c.InMsec or 0) / 1000:7.2f}s 「{c.Comment.strip()}」  色 {before} → 黄")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--names", required=True, help="黄色にするキュー名（カンマ区切り・完全一致）")
    ap.add_argument("--all", action="store_true", help="sync の範囲外の曲も対象にする")
    ap.add_argument("--dry-run", action="store_true", help="出すだけ。何も書き込まない")
    ap.add_argument("--yes", action="store_true", help="確認なしで書く（内容を --dry-run で確認済みのときだけ）")
    args = ap.parse_args()
    names = {norm(n) for n in args.names.split(",") if norm(n)}
    if not names:
        print("--names が空です", file=sys.stderr)
        return 1

    if not args.dry_run and rekordbox_running():
        print("rekordbox が起動中です。終了してから実行してください（--dry-run なら可）。", file=sys.stderr)
        return 1

    db, tmp = open_db(copy=args.dry_run)
    try:
        plan = build_plan(db, names, args.all)
        n = sum(len(v) for v in plan.values())
        if not plan:
            print("黄色にするキューはありません（全部黄色か、その名前のキューが無い）。")
            return 0
        show(db, plan)
        n_hot = sum(1 for v in plan.values() for c in v if c.Kind)
        print(f"\n対象: {len(plan)}曲・{n}キュー（ホット {n_hot} / メモリー {n - n_hot}）")
        if args.dry_run:
            print("--dry-run のため何も書き込みませんでした。")
            return 0
        if not args.yes and input("書き込みますか？ [y/N] > ").strip().lower() not in ("y", "yes"):
            print("何も書き込みませんでした。")
            return 0

        dest = backup()
        print(f"バックアップ: {dest}")
        ids = [c.ID for v in plan.values() for c in v]
        for v in plan.values():
            for c in v:
                if c.Kind:
                    c.Color, c.ColorTableIndex = HOT_YELLOW
                else:
                    c.Color = MEMORY_YELLOW
        db.commit()
    finally:
        db.close()
        if tmp:
            tmp.cleanup()

    # 読み直して確かめる（書いたつもりで書けていないのがいちばん困る）
    db, _ = open_db(copy=False)
    try:
        left = [i for i in ids if not is_yellow(db.get_cue(ID=i))]
    finally:
        db.close()
    if left:
        print(f"⚠ {len(left)} 件が黄色になっていません: {left[:10]}", file=sys.stderr)
        return 1
    print(f"完了: {len(ids)} キューを黄色にしました（読み直して確認済み）。rekordbox を起動して色を確かめてください。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
