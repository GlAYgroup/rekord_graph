#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rekordbox のライブラリと曲ファイルを iCloud Drive にバックアップする。

  ./.venv/bin/python tools/backup.py              # 1回とる
  ./.venv/bin/python tools/backup.py --dry-run    # 何をコピーするかだけ見る
  ./.venv/bin/python tools/backup.py --install    # 毎日 5:00 に自動でとる（launchd）
  ./.venv/bin/python tools/backup.py --uninstall  # 自動を止める

置き場所（既定: iCloud Drive/rekordbox-backup。--dest か REKORD_GRAPH_BACKUP_DIR で変える）:

  library/2026-09-21/rekordbox/     ~/Library/Pioneer/rekordbox（master.db・キュー・波形解析）
  library/2026-09-21/settings/      rekordbox の設定（~/Library/Application Support/Pioneer/rekordbox6）
  library/2026-09-21/rekord_graph/  このリポジトリの data/（移行記録など。git に入らない個人データ）
  files/Users/.../Music/...         曲ファイル。master.db が参照するものを**同じ絶対パスの形で**置く

- **ライブラリは日付ごとの世代で持つ**（既定 14 世代）。iCloud は同期であって版を持たないので、
  壊れた master.db で上書きすると戻れない。世代があれば前の日に戻せる
- **曲ファイルは絶対パスの形のまま置く**。rekordbox は曲をフルパスで探すので、
  戻すときに同じ場所へ置けば「曲が見つからない」にならない。消えた曲もバックアップ側からは消さない
- **rekordbox の起動中は何もしない**。書きかけの master.db を掴むと、戻しても開けない
- rekordbox アカウントのトークン類はコピーしない（ログインし直せば戻る）

戻し方: rekordbox を終了して、`library/<日付>/rekordbox/` を ~/Library/Pioneer/rekordbox に、
`settings/` を ~/Library/Application Support/Pioneer/rekordbox6 に、
`files/` の中身を `/` からの同じパスにコピーする。
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rb_export import RB_DIR, copy_db  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
ICLOUD = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs"
DEFAULT_DEST = Path(os.environ.get("REKORD_GRAPH_BACKUP_DIR") or ICLOUD / "rekordbox-backup")
SETTINGS_DIR = Path.home() / "Library/Application Support/Pioneer/rekordbox6"
KEEP = 14

LABEL = "com.rekord-graph.backup"
PLIST = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
LOG = Path.home() / "Library/Logs/rekord_graph_backup.log"


def rekordbox_running() -> bool:
    r = subprocess.run(["pgrep", "-x", "rekordbox"], capture_output=True)
    return r.returncode == 0


def skip_secret(name: str) -> bool:
    """アカウントのトークン類。自分の iCloud でも、置いておく理由が無い。"""
    return "tkn" in name or "Grant" in name or name == "rb_guser"


def track_paths() -> list[Path]:
    """master.db が参照している曲ファイル（ローカルにあるものだけ。Spotify 等は除く）。"""
    from pyrekordbox import Rekordbox6Database

    with tempfile.TemporaryDirectory() as tmp:
        db = Rekordbox6Database(path=str(copy_db(Path(tmp))), unlock=True)
        try:
            paths = {c.FolderPath for c in db.get_content() if c.FolderPath}
        finally:
            db.close()
    return sorted(Path(p) for p in paths if p.startswith("/"))


def same(src: Path, dst: Path) -> bool:
    if not dst.exists():
        return False
    a, b = src.stat(), dst.stat()
    return a.st_size == b.st_size and int(a.st_mtime) == int(b.st_mtime)


def copy_tree(src: Path, dst: Path, dry: bool) -> int:
    if not src.exists():
        return 0
    if not dry:
        shutil.copytree(src, dst, ignore=lambda _d, names: [n for n in names if skip_secret(n)],
                        dirs_exist_ok=True)
    return sum(1 for p in src.rglob("*") if p.is_file() and not skip_secret(p.name))


def backup(dest: Path, keep: int, dry: bool) -> int:
    if rekordbox_running():
        print("rekordbox が起動中なのでスキップします（終了してから、または次回の自動実行で取ります）")
        return 0

    today = dt.date.today().isoformat()
    gen = dest / "library" / today
    n_lib = copy_tree(RB_DIR, gen / "rekordbox", dry)
    n_set = copy_tree(SETTINGS_DIR, gen / "settings", dry)
    n_data = copy_tree(REPO / "data", gen / "rekord_graph", dry)
    print(f"ライブラリ: {n_lib} ファイル / 設定: {n_set} / data: {n_data} → {gen}")

    copied, unchanged, failed = 0, 0, []
    for src in track_paths():
        dst = dest / "files" / src.relative_to("/")
        try:
            if same(src, dst):
                unchanged += 1
                continue
            if not dry:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            copied += 1
        except OSError as e:  # 消えた曲・macOS の権限で読めない場所（~/Music/Music 等）
            failed.append(f"{src}: {e.strerror or e}")
    print(f"曲ファイル: {copied} 件コピー / {unchanged} 件は変更なし / {len(failed)} 件失敗")
    for f in failed:
        print(f"  ! {f}")

    gens = sorted(p for p in (dest / "library").glob("????-??-??") if p.is_dir())
    for old in gens[:-keep] if keep > 0 else []:
        print(f"古い世代を削除: {old.name}")
        if not dry:
            shutil.rmtree(old)
    if dry:
        print("（--dry-run: 何も書いていません）")
    return 1 if failed else 0


def install(dest: Path) -> None:
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    plist = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, str(Path(__file__).resolve()), "--dest", str(dest)],
        # スリープ中に時刻を過ぎたら、起きたときに1回走る
        "StartCalendarInterval": {"Hour": 5, "Minute": 0},
        "StandardOutPath": str(LOG),
        "StandardErrorPath": str(LOG),
    }
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(PLIST)], capture_output=True)
    PLIST.write_bytes(plistlib.dumps(plist))
    subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(PLIST)], check=True)
    print(f"毎日 5:00 にバックアップします（{PLIST}）。ログ: {LOG}")
    print(f"今すぐ試すなら: launchctl kickstart gui/{os.getuid()}/{LABEL}")


def uninstall() -> None:
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(PLIST)], capture_output=True)
    PLIST.unlink(missing_ok=True)
    print("自動バックアップを止めました（取ってあるバックアップはそのまま）")


def main() -> int:
    ap = argparse.ArgumentParser(description="rekordbox のライブラリと曲ファイルを iCloud Drive にバックアップする")
    ap.add_argument("--dest", type=Path, default=DEFAULT_DEST)
    ap.add_argument("--keep", type=int, default=KEEP, help=f"ライブラリの世代数（既定 {KEEP}）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--install", action="store_true", help="毎日 5:00 に自動で取る")
    ap.add_argument("--uninstall", action="store_true")
    args = ap.parse_args()

    if args.uninstall:
        uninstall()
        return 0
    if args.install:
        install(args.dest)
        return 0
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M}] バックアップ先: {args.dest}")
    return backup(args.dest, args.keep, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
