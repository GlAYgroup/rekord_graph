#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rekordbox master.db の置き場所・コピー・書き込み前の安全確認を1か所にまとめる。

master.db を読む・書くツールは全部ここを通す（以前は rb_tags.py が場所を自前で決め、
`REKORDBOX_DIR` を無視して既定の場所を開いていた。起動中の確認も各ツールにバラバラにあった）。

- 読むだけ: `temp_copy()` でコピーしてから開く（実ファイルは開かない = rekordbox 起動中でも安全）。
  コピーは `<一時ディレクトリ>/rekord_graph/` の下に作り、**新しい2つだけ残して古いものは消す**
- 書く: `refuse_if_running()` → `backup()` → `open_live()`。commit の直前にも `refuse_if_running()` を
  もう一度呼ぶ（確認の y/n を待つ間に rekordbox を起動されることがある）

config も rb_export も import しない（rb_export が import 時に config を読むので、循環と副作用を避ける）。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path


def rekordbox_dir() -> Path:
    """rekordbox 6/7 の master.db がある場所。環境変数 REKORDBOX_DIR で上書きできる。"""
    if os.environ.get("REKORDBOX_DIR"):
        return Path(os.environ["REKORDBOX_DIR"])
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming")) / "Pioneer/rekordbox"
    return Path.home() / "Library/Pioneer/rekordbox"


RB_DIR = rekordbox_dir()
LIVE_DB = RB_DIR / "master.db"
# 書き込み前のバックアップ（rb_tags.py から引き継いだ場所。世代は消さない）
BACKUP_ROOT = Path.home() / "Library/Pioneer/rekordbox_backups_rekord_graph"
# 読むためのコピーの置き場。新しい KEEP_TEMP 個だけ残す
TEMP_ROOT = Path(tempfile.gettempdir()) / "rekord_graph"
KEEP_TEMP = 2


def copy_db(dest: Path) -> Path:
    """master.db と -wal / -shm をまとめてコピーする。-wal を持っていかないと直近の編集が欠ける。"""
    for suffix in ("", "-wal", "-shm"):
        src = RB_DIR / f"master.db{suffix}"
        if src.exists():
            shutil.copy2(src, dest / f"master.db{suffix}")
    return dest / "master.db"


def _stamp() -> str:
    # 名前で並べれば古い順になるよう、ゼロ埋めの時刻 + pid（同じ瞬間に2プロセスでも衝突しない）
    return f"{datetime.now():%Y%m%d-%H%M%S-%f}-{os.getpid()}"


def prune_temp(keep: int = KEEP_TEMP) -> None:
    """コピー置き場を新しい keep 個だけにする。

    注意: 別のプロセス（毎朝の backup.py など）がちょうど読んでいる古いコピーを消すことがある。
    その場合は向こうがもう一度走れば済む（実機は触らない）。
    """
    if not TEMP_ROOT.is_dir():
        return
    dirs = sorted(p for p in TEMP_ROOT.iterdir() if p.is_dir())
    for old in dirs[:-keep] if keep > 0 else dirs:
        shutil.rmtree(old, ignore_errors=True)


def temp_copy() -> Path:
    """master.db を一時置き場へコピーし、そのパスを返す（読むだけの用途）。古いコピーは2つまで残して消す。"""
    d = TEMP_ROOT / _stamp()
    d.mkdir(parents=True, exist_ok=True)
    path = copy_db(d)
    prune_temp()
    return path


def rekordbox_running() -> bool:
    return subprocess.run(["pgrep", "-x", "rekordbox"], capture_output=True).returncode == 0


def refuse_if_running(what: str = "master.db への書き込み") -> None:
    """rekordbox が起動中なら止める（SystemExit）。書く前・commit の直前に呼ぶ。"""
    if rekordbox_running():
        raise SystemExit(f"rekordbox が起動中です。{what}は rekordbox を終了してから実行してください。")


def backup() -> Path:
    """master.db / -wal / -shm を丸ごと BACKUP_ROOT/<日時>/ にコピーする（書く前に必ず呼ぶ）。"""
    refuse_if_running("バックアップと書き込み")
    dest = BACKUP_ROOT / datetime.now().strftime("%Y%m%d-%H%M%S")
    dest.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        src = RB_DIR / f"master.db{suffix}"
        if src.exists():
            shutil.copy2(src, dest / f"master.db{suffix}")
    return dest


def open_copy():
    """コピーを開く（読むだけ）。**`path=` で開く。`db_dir=` は効かず実機が開かれる**（2026-09-09 に実機へ書いた）"""
    from pyrekordbox import Rekordbox6Database

    return Rekordbox6Database(path=str(temp_copy()), unlock=True)


def open_live():
    """実機の master.db を開く（書く用）。呼ぶ前に refuse_if_running() / backup() を済ませること。"""
    from pyrekordbox import Rekordbox6Database

    if not LIVE_DB.exists():
        raise SystemExit(f"master.db が見つかりません: {RB_DIR}（環境変数 REKORDBOX_DIR で場所を指定できます）")
    return Rekordbox6Database(path=str(LIVE_DB), unlock=True)
