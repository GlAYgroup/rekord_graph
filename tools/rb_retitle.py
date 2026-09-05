#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""data/retitle_map.json -> rekordbox master.db のタイトル/アーティストを書き換える

    ./.venv/bin/python tools/rb_retitle.py --dry-run  # 出すだけ。何も書かない
    ./.venv/bin/python tools/rb_retitle.py            # 1件ずつ y/n/a/q で確認
    ./.venv/bin/python tools/rb_retitle.py --yes      # 全件承認（内容を確認済みのときだけ）

master.db への直接書き込みは Pioneer 非公式なので、安全側に倒す:
- 書き込み前に master.db / -wal / -shm を丸ごとバックアップする（必須・スキップ不可）
- rekordbox が起動中なら書き込みを拒否する（--dry-run は可）
- 対応表で status が "ok" の行だけを対象にする（"check" は人の確認待ち）
- 対応表を作った後に rekordbox 側でタイトルが変わっていたら、その行は書かずに警告する

書き終えたら rb_export.py -> sync.py で Notion の 🎵Tracks 鏡を追従させる
（正準IDは ContentID / キューUUID なのでリネームでリレーションは切れない）。
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

RB_DIR = Path.home() / "Library/Pioneer/rekordbox"
BACKUP_ROOT = Path.home() / "Library/Pioneer/rekordbox_backups_rekord_graph"
MAP_PATH = Path(__file__).resolve().parent.parent / "data" / "retitle_map.json"


def nfc(s: str | None) -> str:
    # macOS 由来のタイトルは濁点が分解形（ク+゙）で入っているので、比較は必ず NFC で
    return unicodedata.normalize("NFC", s or "")


def rekordbox_running() -> bool:
    r = subprocess.run(["pgrep", "-x", "rekordbox"], capture_output=True)
    return r.returncode == 0


def backup() -> Path:
    dest = BACKUP_ROOT / datetime.now().strftime("%Y%m%d-%H%M%S")
    dest.mkdir(parents=True)
    for suffix in ("", "-wal", "-shm"):
        src = RB_DIR / f"master.db{suffix}"
        if src.exists():
            shutil.copy2(src, dest / f"master.db{suffix}")
    return dest


def load_map() -> list[dict]:
    return json.loads(MAP_PATH.read_text(encoding="utf-8"))["entries"]


def build_plan(db, entries: list[dict]) -> tuple[list[dict], list[str]]:
    """対応表と実機を突き合わせ、書ける行 / 書けない理由 に分ける。"""
    plan, warns = [], []
    for e in entries:
        if e["status"] != "ok":
            continue
        cont = db.get_content(ID=e["id"])  # ID 指定時は object か None が返る
        if cont is None:
            warns.append(f"曲が見つからない: {e['id']} {e['current_title']!r}（削除された?）")
            continue
        live_title = nfc(cont.Title)
        live_artist = cont.Artist.Name if cont.Artist else None
        title_done = live_title == nfc(e["title"])
        artist_done = (live_artist or None) == (e["artist"] or None)
        if title_done and artist_done:
            continue  # 反映済み。書いた後の実機は current_title と違って当然なので、ずれ検査より先に見る
        if live_title != nfc(e["current_title"]):
            warns.append(
                f"対応表を作った後にタイトルが変わっている: {e['id']}\n"
                f"    対応表: {e['current_title']!r}\n"
                f"    実機:   {cont.Title!r}\n"
                f"    → この行は書かない。対応表を作り直すこと"
            )
            continue
        plan.append(
            {
                "content": cont,
                "entry": e,
                "live_artist": live_artist,
                "write_title": not title_done,
                "write_artist": (not artist_done) and bool(e["artist"]),
            }
        )
    return plan, warns


def show(item: dict, i: int, total: int) -> None:
    e = item["entry"]
    print(f"\n[{i}/{total}] {e['current_title']}")
    if item["write_title"]:
        print(f"    曲名:       → {e['title']}")
    if item["write_artist"]:
        print(f"    アーティスト: {item['live_artist'] or '（空）'} → {e['artist']}")


def get_or_create_artist(db, name: str, cache: dict):
    if name in cache:
        return cache[name]
    artist = db.get_artist(Name=name).first()
    if artist is None:
        artist = db.add_artist(name)
        print(f"    アーティスト行を新規作成: {name}")
    cache[name] = artist
    return artist


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="差分を出すだけ。何も書き込まない")
    ap.add_argument("--yes", action="store_true", help="全件承認する（内容を確認済みのときだけ）")
    args = ap.parse_args()

    if not (RB_DIR / "master.db").exists():
        print(f"master.db が見つかりません: {RB_DIR}", file=sys.stderr)
        return 1

    entries = load_map()
    n_check = sum(1 for e in entries if e["status"] != "ok")

    if not args.dry_run and rekordbox_running():
        print("rekordbox が起動中です。終了してから実行してください（--dry-run なら可）。", file=sys.stderr)
        return 1

    print("rekordbox master.db を開いています…")
    from pyrekordbox import Rekordbox6Database

    if args.dry_run:
        # 読むだけなので実ファイルは開かない（rekordbox 起動中でも安全）
        import tempfile

        tmp = tempfile.TemporaryDirectory()
        for suffix in ("", "-wal", "-shm"):
            src = RB_DIR / f"master.db{suffix}"
            if src.exists():
                shutil.copy2(src, Path(tmp.name) / f"master.db{suffix}")
        db = Rekordbox6Database(path=str(Path(tmp.name) / "master.db"), unlock=True)
    else:
        db = Rekordbox6Database(unlock=True)
    try:
        plan, warns = build_plan(db, entries)

        for w in warns:
            print(f"\n⚠ {w}")
        if n_check:
            print(f"\n（status=check の {n_check} 件は確認待ちのため対象外）")

        if not plan:
            print("\n書き込みが必要な変更はありません。")
            return 0

        for i, item in enumerate(plan, 1):
            show(item, i, len(plan))

        if args.dry_run:
            print(f"\n--dry-run のため何も書き込みませんでした（対象 {len(plan)} 件）。")
            return 0

        print("\n" + "=" * 60)
        approved = []
        for i, item in enumerate(plan, 1):
            if args.yes:
                approved.append(item)
                continue
            show(item, i, len(plan))
            ans = input("        反映しますか？ [y]es / [n]o / [a]ll / [q]uit > ").strip().lower()
            if ans == "q":
                break
            if ans == "a":
                approved.extend(plan[i - 1:])
                break
            if ans in ("y", "yes"):
                approved.append(item)

        if not approved:
            print("\n何も反映しませんでした。")
            return 0

        dest = backup()
        print(f"\nバックアップ: {dest}")

        print(f"{len(approved)} 件を master.db に書き込みます…")
        artist_cache: dict = {}
        for item in approved:
            cont, e = item["content"], item["entry"]
            if item["write_title"]:
                cont.Title = e["title"]
            if item["write_artist"]:
                artist = get_or_create_artist(db, e["artist"], artist_cache)
                cont.ArtistID = artist.ID
        db.commit()
        print("完了。rekordbox を起動して表示を確認してください。")
        print("次: ./.venv/bin/python tools/rb_export.py && ./.venv/bin/python tools/sync.py --dry-run")
        return 0
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
