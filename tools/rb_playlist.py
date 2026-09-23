#!/usr/bin/env python3
"""アプリで作ったイベントのプレイリスト（Notion 🎶Playlists）を rekordbox に書き出す。

アプリ（Vercel）からは master.db に触れないので、rekordbox への書き出しはこのコマンドだけが行う。

- 書く先は rekordbox の **`rekord_graph` フォルダの中だけ**（無ければ作る）。フォルダの外の
  プレイリストには触らない（手で作ったもの・前に作った「HERO始まり 最大27曲」など）
- フォルダの中に同じ名前があれば、**中身を入れ替える**（アプリが正。並び順 = rekordbox の番号 1..N）
- 曲は rekordbox の ContentID で引く。見つからない曲があるプレイリストは**書かずに**報告する
  （抜けたまま書くと、番号が詰まって気付けない）
- 既定は何も書かない（コピーで確かめるだけ。コミットもしない）。`--apply` で実機に書く。
  **rekordbox を終了してから**（起動中は pyrekordbox が書き込みを拒む）。書いた後に読み直して、
  並びと番号 1..N を確かめる

    ./.venv/bin/python tools/rb_playlist.py                 # 何が変わるかを見るだけ
    ./.venv/bin/python tools/rb_playlist.py --apply         # 全部書き出す
    ./.venv/bin/python tools/rb_playlist.py --name "◯◯" --apply   # 1本だけ
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import tempfile

sys.path.insert(0, "tools")
import notion_api as na
import rb_export

FOLDER = "rekord_graph"


def load_playlists() -> list[dict]:
    if "playlists" not in na.CONFIG:
        raise SystemExit("🎶Playlists の database ID が設定にありません（tools/setup_notion.py --add playlists --write）")
    out = []
    for page in na.query_all(na.CONFIG["playlists"]):
        p = page["properties"]
        out.append({
            "name": na.plain(p.get("名前")).strip(),
            "ids": na.plain(p.get("曲")).split(),
        })
    return [pl for pl in out if pl["name"]]


def songs_of(db, playlist) -> list:
    return sorted(db.get_playlist_songs(PlaylistID=playlist.ID), key=lambda s: s.TrackNo or 0)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="実機の master.db に書く（rekordbox を終了してから）")
    ap.add_argument("--name", help="この名前のプレイリストだけ")
    args = ap.parse_args()

    playlists = load_playlists()
    if args.name:
        playlists = [pl for pl in playlists if pl["name"] == args.name]
        if not playlists:
            print(f"Notion に「{args.name}」というプレイリストがありません", file=sys.stderr)
            return 1
    names = [pl["name"] for pl in playlists]
    dup = sorted({n for n in names if names.count(n) > 1})
    if dup:
        print(f"同じ名前のプレイリストが Notion に複数あります（どちらを書くか決められない）: {dup}", file=sys.stderr)
        return 1

    path = rb_export.RB_DIR / "master.db" if args.apply else rb_export.copy_db(pathlib.Path(tempfile.mkdtemp()))
    from pyrekordbox import Rekordbox6Database
    db = Rekordbox6Database(path=str(path), unlock=True)

    folder = db.get_playlist(Name=FOLDER, ParentID="root", Attribute=1).one_or_none()
    if folder is None:
        print(f"フォルダを作成  {FOLDER}")
        folder = db.create_playlist_folder(FOLDER) if args.apply else None

    written: list[tuple[str, list[str]]] = []
    for pl in playlists:
        missing = [cid for cid in pl["ids"] if db.get_content(ID=cid) is None]
        if missing:
            print(f"✗ {pl['name']}: rekordbox に無い曲があるので書きません: {missing}")
            continue
        current = db.get_playlist(Name=pl["name"], ParentID=folder.ID).one_or_none() if folder else None
        before = [s.ContentID for s in songs_of(db, current)] if current else None
        if before == pl["ids"]:
            print(f"  {pl['name']}: 変更なし（{len(pl['ids'])}曲）")
            continue
        print(f"{'新規' if before is None else '更新'}  {pl['name']}: "
              f"{'' if before is None else f'{len(before)}曲 → '}{len(pl['ids'])}曲")
        if not args.apply:
            continue
        if current is None:
            current = db.create_playlist(pl["name"], parent=folder)
        for song in songs_of(db, current):
            db.remove_from_playlist(current, song)
        for i, cid in enumerate(pl["ids"], 1):
            db.add_to_playlist(current, cid, track_no=i)
        written.append((pl["name"], pl["ids"]))

    if not args.apply:
        print("\n（試しただけ）--apply で実機に書きます。rekordbox を終了してから")
        return 0
    if not written:
        return 0
    db.commit()

    # 読み直して、並びと番号 1..N を確かめる
    db = Rekordbox6Database(path=str(path), unlock=True)
    folder = db.get_playlist(Name=FOLDER, ParentID="root", Attribute=1).one()
    bad = 0
    for name, ids in written:
        rows = songs_of(db, db.get_playlist(Name=name, ParentID=folder.ID).one())
        ok = [s.ContentID for s in rows] == ids and [s.TrackNo for s in rows] == list(range(1, len(ids) + 1))
        bad += not ok
        print(f"{'✓' if ok else '✗ 並びが違う'} {name}（{len(rows)}曲）")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
