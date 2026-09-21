#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rekordbox のライブラリと曲ファイルを iCloud Drive に同期する（Mac → iCloud の片方向）。

  ./.venv/bin/python tools/backup.py              # 1回同期する
  ./.venv/bin/python tools/backup.py --dry-run    # 何をするかだけ見る
  ./.venv/bin/python tools/backup.py --install    # 毎日 5:00 に自動で同期する（launchd）
  ./.venv/bin/python tools/backup.py --uninstall  # 自動を止める

目的は「この Mac が無くなっても元どおりに戻せる」こと。置き場所
（既定: iCloud Drive/rekordbox-backup。--dest か REKORD_GRAPH_BACKUP_DIR で変える）:

  library/latest/rekordbox/      ~/Library/Pioneer/rekordbox（master.db・キュー・プレイリスト・波形解析・アートワーク）
  library/latest/settings/       rekordbox の設定（~/Library/Application Support/Pioneer/rekordbox6）
  library/latest/rekord_graph/   このリポジトリの data/（移行記録など。git に入らない個人データ）
  library/previous/              ひとつ前の同期の library/latest
  files/Users/.../Music/...      曲ファイル。元の絶対パスの形のまま
  previous/files/...             ひとつ前の同期で上書き・削除された曲ファイル

- **最新版＋ひとつ前だけを持つ**。iCloud は同期であって版を持たないので、
  壊れた master.db で上書きしても前回分に戻れるよう1世代だけ残す
- **曲ファイルは「曲が入っているフォルダ」を丸ごと鏡にする**（~/Music/DJ_songs など）。
  ライブラリに取り込んでいない音源やメモも戻せるように。Mac で消したファイルは
  iCloud からも消える（前回分として previous/ に1回ぶん残る）。
  Apple Music の管理フォルダ（~/Music/Music）など、それ以外の場所にある曲はその曲だけ持つ
- **元の絶対パスの形で置く**。rekordbox は曲をフルパスで探すので、同じ場所へ戻せば
  「曲が見つからない」にならない（ユーザー名が変わったら rekordbox の「再配置」で直す）
- **rekordbox の起動中は何もしない**。書きかけの master.db を掴むと、戻しても開けない
- rekordbox アカウントのトークン類はコピーしない（ログインし直せば戻る）
- Spotify などストリーミングの曲はファイルが無いので持てない（キューは master.db に残る）

戻し方（新しい Mac）: rekordbox を入れて一度起動 → 終了し、
`library/latest/rekordbox/` を ~/Library/Pioneer/rekordbox に、
`library/latest/settings/` を ~/Library/Application Support/Pioneer/rekordbox6 に、
`files/` の中身を `/` からの同じパスにコピーしてから rekordbox を起動する。
USB（exportLibrary.db）は master.db から rekordbox の「デバイスへエクスポート」で作り直せる。
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
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rb_export import RB_DIR, copy_db  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
ICLOUD = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs"
DEFAULT_DEST = Path(os.environ.get("REKORD_GRAPH_BACKUP_DIR") or ICLOUD / "rekordbox-backup")
SETTINGS_DIR = Path.home() / "Library/Application Support/Pioneer/rekordbox6"
MUSIC = Path.home() / "Music"
# 丸ごと鏡にしないフォルダ（Apple Music の管理下。中の曲はライブラリにある分だけ持つ）
NOT_WHOLE = {"Music", "iTunes"}
# rekordbox の録音・サンプラー。ライブラリに無くても持つ
ALWAYS = [MUSIC / "rekordbox", MUSIC / "PioneerDJ"]
JUNK = {".DS_Store"}

LABEL = "com.rekord-graph.backup"
PLIST = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
LOG = Path.home() / "Library/Logs/rekord_graph_backup.log"


def rekordbox_running() -> bool:
    return subprocess.run(["pgrep", "-x", "rekordbox"], capture_output=True).returncode == 0


def skip_secret(name: str) -> bool:
    """アカウントのトークン類。自分の iCloud でも、置いておく理由が無い。"""
    return "tkn" in name or "Grant" in name or name == "rb_guser"


def key(p: Path | str) -> str:
    """macOS のファイル名は NFD、master.db は NFC で持つので、比べる前に揃える。"""
    return unicodedata.normalize("NFC", str(p))


def track_paths() -> list[Path]:
    """master.db が参照している曲ファイル（Spotify 等のストリーミングは除く）。"""
    from pyrekordbox import Rekordbox6Database

    with tempfile.TemporaryDirectory() as tmp:
        db = Rekordbox6Database(path=str(copy_db(Path(tmp))), unlock=True)
        try:
            paths = {c.FolderPath for c in db.get_content() if c.FolderPath}
        finally:
            db.close()
    return sorted(Path(p) for p in paths if p.startswith("/"))


def sources(tracks: list[Path]) -> tuple[list[Path], list[Path]]:
    """(丸ごと鏡にするフォルダ, 1曲ずつ持つファイル)。"""
    roots = {r for r in ALWAYS if r.is_dir()}
    singles = []
    for t in tracks:
        try:
            top = t.relative_to(MUSIC).parts[0]
        except ValueError:
            singles.append(t)
            continue
        if top in NOT_WHOLE:
            singles.append(t)
        else:
            roots.add(MUSIC / top)
    return sorted(roots), singles


def same(src: Path, dst: Path) -> bool:
    if not dst.exists():
        return False
    a, b = src.stat(), dst.stat()
    return a.st_size == b.st_size and int(a.st_mtime) == int(b.st_mtime)


def sync_library(dest: Path, dry: bool) -> None:
    """library/.new に作ってから latest → previous → 捨てる、の順に回す（途中で落ちても latest が欠けない）。"""
    lib = dest / "library"
    new = lib / ".new"
    parts = [(RB_DIR, "rekordbox"), (SETTINGS_DIR, "settings"), (REPO / "data", "rekord_graph")]
    counts = []
    if not dry:
        shutil.rmtree(new, ignore_errors=True)  # 前回途中で落ちた残り
    for src, name in parts:
        files = [p for p in src.rglob("*") if p.is_file() and not skip_secret(p.name)] if src.exists() else []
        counts.append(f"{name} {len(files)}")
        if not dry and src.exists():
            shutil.copytree(src, new / name, dirs_exist_ok=True,
                            ignore=lambda _d, names: [n for n in names if skip_secret(n)])
    print(f"ライブラリ: {' / '.join(counts)} ファイル")
    if dry:
        return
    shutil.rmtree(lib / "previous", ignore_errors=True)
    if (lib / "latest").exists():
        (lib / "latest").rename(lib / "previous")
    new.rename(lib / "latest")
    for old in lib.glob("????-??-??"):  # 以前の日付ごとの世代
        shutil.rmtree(old)


def sync_files(dest: Path, dry: bool) -> list[str]:
    files, prev = dest / "files", dest / "previous" / "files"
    roots, singles = sources(track_paths())
    print("丸ごと同期するフォルダ: " + ", ".join(str(r).replace(str(Path.home()), "~") for r in roots))

    wanted: dict[str, Path] = {}  # 鏡に置くべきファイル（NFC のパス → 元）
    for r in roots:
        for p in r.rglob("*"):
            if p.is_file() and p.name not in JUNK:
                wanted[key(p)] = p
    for p in singles:
        wanted.setdefault(key(p), p)

    if not dry:
        shutil.rmtree(prev, ignore_errors=True)

    def retire(dst: Path) -> None:
        """上書き・削除する前に previous/ へ退避する（ひとつ前の分として残す）。"""
        if dry:
            return
        to = prev / dst.relative_to(files)
        to.parent.mkdir(parents=True, exist_ok=True)
        dst.rename(to)

    copied = unchanged = removed = 0
    failed: list[str] = []
    for src in wanted.values():
        dst = files / src.relative_to("/")
        try:
            if same(src, dst):
                unchanged += 1
                continue
            if dst.exists():
                retire(dst)
            if not dry:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            copied += 1
        except OSError as e:  # 消えた曲・macOS の権限で読めない場所
            failed.append(f"{src}: {e.strerror or e}")

    if files.exists():
        for dst in [p for p in files.rglob("*") if p.is_file()]:
            if key("/" / dst.relative_to(files)) not in wanted:
                retire(dst)
                removed += 1
    print(f"曲ファイル: {copied} 件コピー / {unchanged} 件は変更なし / {removed} 件を削除（previous/ に退避） / {len(failed)} 件失敗")
    for f in failed:
        print(f"  ! {f}")
    return failed


def backup(dest: Path, dry: bool) -> int:
    if rekordbox_running():
        print("rekordbox が起動中なのでスキップします（終了してから、または次回の自動実行で同期します）")
        return 0
    failed = sync_files(dest, dry)
    sync_library(dest, dry)
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
    print(f"毎日 5:00 に同期します（{PLIST}）。ログ: {LOG}")
    print(f"今すぐ試すなら: launchctl kickstart gui/{os.getuid()}/{LABEL}")


def uninstall() -> None:
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(PLIST)], capture_output=True)
    PLIST.unlink(missing_ok=True)
    print("自動同期を止めました（iCloud 上のものはそのまま）")


def main() -> int:
    ap = argparse.ArgumentParser(description="rekordbox のライブラリと曲ファイルを iCloud Drive に同期する")
    ap.add_argument("--dest", type=Path, default=DEFAULT_DEST)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--install", action="store_true", help="毎日 5:00 に自動で同期する")
    ap.add_argument("--uninstall", action="store_true")
    args = ap.parse_args()

    if args.uninstall:
        uninstall()
        return 0
    if args.install:
        install(args.dest)
        return 0
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M}] 同期先: {args.dest}")
    return backup(args.dest, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
