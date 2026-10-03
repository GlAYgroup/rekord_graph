#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rekordbox master.db -> data/rekordbox.json

master.db は SQLCipher 暗号化されているため pyrekordbox で復号して読む。
rekordbox 起動中は -wal に未反映の変更があるので、必ずコピーしてから読む
（実ファイルは決して開かない）。

出力は Notion の 🎵Tracks / 📍Cues DB の投入元であり、
同期レビュー（差分検出）の前回スナップショットも兼ねる。
キューの正準IDは rekordbox の UUID。記号やキュー名が変わっても UUID は不変なので、
「名前が似ているから同じキューだろう」という推測なしに差分を取れる。
"""
from __future__ import annotations

import argparse
import fnmatch
import os
import json
import shutil
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import config


def rekordbox_dir() -> Path:
    """rekordbox 6/7 の master.db がある場所。環境変数 REKORDBOX_DIR で上書きできる。"""
    if os.environ.get("REKORDBOX_DIR"):
        return Path(os.environ["REKORDBOX_DIR"])
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming")) / "Pioneer/rekordbox"
    return Path.home() / "Library/Pioneer/rekordbox"


RB_DIR = rekordbox_dir()
OUT = Path(__file__).resolve().parent.parent / "data" / "rekordbox.json"

# rekordbox の Kind: 0 = メモリーキュー、1..3 = ホットキュー A..C、**4 は使われず**、5.. = D..
# 実測（2026-08-25, rekordbox 7.2.18）: ライブラリ573件のキューに Kind=4 が1件も無く、
# 実機の画面で D「1サビ終」のキューは DB では Kind=5 だった（Bad Apple!! で確認）。
# 以前の「1..16 = A..P」の素朴な対応では **D 以降の記号が全部1つ後ろにズレる**。
HOTCUE_LETTERS = "ABCDEFGHIJKLMNOP"


def copy_db(dest: Path) -> Path:
    """master.db と -wal / -shm をまとめてコピーする。

    -wal を持っていかないと直近の編集が欠ける。
    """
    for suffix in ("", "-wal", "-shm"):
        src = RB_DIR / f"master.db{suffix}"
        if src.exists():
            shutil.copy2(src, dest / f"master.db{suffix}")
    return dest / "master.db"


def cue_letter(kind: int | None) -> str | None:
    if not kind:
        return None
    if 1 <= kind <= 3:
        return HOTCUE_LETTERS[kind - 1]
    if 5 <= kind <= len(HOTCUE_LETTERS) + 1:
        return HOTCUE_LETTERS[kind - 2]
    # Kind=4 は黙って割り当てない。2026-09-22 に初めて1件現れた（え?あぁ、そう。0:55.785 の
    # 名前なし5秒ループ）が、本人にもどのパッドか分からなかった。記号は None のまま返し、
    # sync はそのキューを同期せず警告だけ出す（`load_rekordbox`）
    return None


# プレイリスト所属は「どの曲を優先して扱うか」の判断材料。
# config.json の rekordbox.priorityPlaylist に入っている曲は、フォルダの絞り込みに関係なく必ず含める
PRIORITY_PLAYLIST = config.rekordbox_options()["priorityPlaylist"]


class ScopeError(ValueError):
    """rekordbox.scopePlaylists に書いたプレイリスト/フォルダが rekordbox に無い。"""


def scope_track_ids(playlists: list, contents_of, scope: list[str],
                    exclude: list[str] | None = None) -> set[str]:
    """scope の各名前（`フォルダ/プレイリスト` のように / で区切れる）の配下にある曲ID。

    フォルダなら中を全部たどる。`exclude`（`*_check_repo` のようなワイルドカード）に名前が当たる
    プレイリストは中を見ない。外すのはプレイリスト単位なので、他のプレイリストにも入っている曲は残る。名前が1つでも見つからなければ止める —
    黙って空振りすると、その配下の曲が全部「消えた曲」に見える
    （priorityPlaylist の「ボカロ_整理済」は名前が変わって何にも当たらないまま動いていた。2026-10-03）
    """
    children: dict[str, list] = defaultdict(list)
    for pl in playlists:
        children[str(pl.ParentID)].append(pl)

    def find(path: str):
        parent, node = "root", None
        for part in path.split("/"):
            node = next((c for c in children[parent] if c.Name == part), None)
            if node is None:
                return None
            parent = str(node.ID)
        return node

    ids: set[str] = set()

    def walk(node) -> None:
        if any(fnmatch.fnmatchcase(node.Name, pat) for pat in exclude or []):
            return
        if node.is_folder:
            for c in children[str(node.ID)]:
                walk(c)
        else:
            ids.update(str(t.ID) for t in contents_of(node))

    missing = []
    for name in scope:
        node = find(name)
        if node is None:
            missing.append(name)
        else:
            walk(node)
    if missing:
        roots = ", ".join(c.Name for c in children["root"])
        raise ScopeError(f"rekordbox.scopePlaylists のプレイリスト/フォルダが見つかりません: {missing}\n"
                         f"  一番上にあるもの: {roots}")
    return ids


def rename_track_ids() -> set[str]:
    """曲名を整える対象（`rb_tags.py --audit`）の曲ID = scopePlaylists 配下から
    rekordbox.renameExcludePlaylists に名前が当たるプレイリストを外したもの。

    `*_check_repo` は取り込んだばかりで使うか決めていない曲の置き場なので、曲名を整える手間をかけない。
    sync の範囲（scopePlaylists）はそのまま — 外すと Notion から見えなくなる
    """
    from pyrekordbox import Rekordbox6Database

    opts = config.rekordbox_options()
    if not opts["scopePlaylists"]:
        raise ScopeError("rekordbox.scopePlaylists が空です（曲名を整える対象はその配下で決めます）")
    with tempfile.TemporaryDirectory() as tmp:
        db = Rekordbox6Database(path=str(copy_db(Path(tmp))), unlock=True)
        try:
            return scope_track_ids(db.get_playlist().all(), db.get_playlist_contents,
                                   opts["scopePlaylists"], opts["renameExcludePlaylists"])
        finally:
            db.close()


def export_configured() -> dict:
    """config.json の rekordbox.* の絞り込みどおりに読む（sync・rb_tags の入口）。"""
    opts = config.rekordbox_options()
    return export(opts["folderFilter"], opts["scopePlaylists"])


def export(only: str | None = None, scope: list[str] | None = None) -> dict:
    """rekordbox のライブラリを読む。

    `scope` = このプレイリスト/フォルダ配下の曲だけ（指定すると `only` は使わない）。
    `only` = このパス片を含む曲だけ。どちらも None なら全曲。
    返す `outOfScope` は「ライブラリにはあるが絞り込みで外した曲ID」。sync はこれを
    「消えた曲」と区別し、Notion から消さない（プレイリストから外しただけで繋ぎが見えなくなるため）。
    """
    from pyrekordbox import Rekordbox6Database

    with tempfile.TemporaryDirectory() as tmp:
        db = Rekordbox6Database(path=str(copy_db(Path(tmp))), unlock=True)

        cues_by_track: dict[str, list] = defaultdict(list)
        for c in db.get_cue():
            cues_by_track[str(c.ContentID)].append(c)

        playlists_by_track: dict[str, list[str]] = defaultdict(list)
        for pl in db.get_playlist():
            # フォルダは「曲が入る場所」ではないので飛ばす。
            # 中身を訊くと pyrekordbox が ValueError を投げて export ごと落ちる
            # （実際に落ちた: 2026-09-11、プレイリストを「ボカロ」フォルダにまとめた直後）。
            # 判定は pyrekordbox 自身が使っている is_folder に合わせる（Attribute の値を自前で持たない）
            if pl.is_folder:
                continue
            for t in db.get_playlist_contents(pl):
                playlists_by_track[str(t.ID)].append(pl.Name)
        if PRIORITY_PLAYLIST and not any(PRIORITY_PLAYLIST in names for names in playlists_by_track.values()):
            print(f"  ⚠ rekordbox.priorityPlaylist「{PRIORITY_PLAYLIST}」に当たる曲がありません"
                  "（名前が変わったか、空のプレイリスト）", file=sys.stderr)
        in_scope = scope_track_ids(db.get_playlist().all(), db.get_playlist_contents, scope) if scope else None

        # My Tag = 「カテゴリ/タグ」（`原曲/アニメ`）。ジャンル欄は1つしか入らないので、
        # 原曲の分類はこちらに置いている（tools/rb_mytag.py）
        my_tags = {str(m.ID): m for m in db.get_my_tag()}
        tags_by_track: dict[str, list[str]] = defaultdict(list)
        for s in db.get_my_tag_songs():
            m = my_tags.get(str(s.MyTagID))
            parent = my_tags.get(str(m.ParentID)) if m else None
            if m and parent:
                tags_by_track[str(s.ContentID)].append(f"{parent.Name}/{m.Name}")

        tracks = []
        out_of_scope = []
        for t in db.get_content():
            path = t.FolderPath or ""
            # 優先プレイリストの曲は、パスがどこにあっても必ず含める
            in_priority = bool(PRIORITY_PLAYLIST) and PRIORITY_PLAYLIST in playlists_by_track.get(str(t.ID), [])
            if in_scope is not None:
                keep = str(t.ID) in in_scope or in_priority
            else:
                keep = not only or only in path or in_priority
            if not keep:
                out_of_scope.append(str(t.ID))
                continue

            cues = []
            for c in sorted(cues_by_track.get(str(t.ID), []), key=lambda x: x.InMsec or 0):
                cues.append(
                    {
                        "uuid": c.UUID,
                        "kind": "memory" if not c.Kind else "hot",
                        "letter": cue_letter(c.Kind),
                        "name": (c.Comment or "").strip(),
                        "rawName": c.Comment or "",  # 末尾スペースまで一致するので原文も残す
                        "positionMs": c.InMsec,
                        # ループかどうかの唯一の手掛かりは「終わりの位置が入っているか」。
                        # BeatLoopSize はビートループで作ったものにしか入らない（実測: ループ54件中15件だけ）
                        "loop": bool(c.OutMsec and c.OutMsec > 0),
                        "loopEndMs": c.OutMsec if (c.OutMsec and c.OutMsec > 0) else None,
                        "loopBars": c.BeatLoopSize or None,
                    }
                )

            tracks.append(
                {
                    "id": str(t.ID),
                    "title": t.Title or "",
                    "artist": t.Artist.Name if t.Artist else None,
                    "genre": t.Genre.Name if t.Genre else None,
                    "myTags": sorted(set(tags_by_track.get(str(t.ID), []))),
                    "bpm": round((t.BPM or 0) / 100.0, 2),
                    "key": t.Key.ScaleName if t.Key else None,
                    "durationSec": t.Length or None,  # 波形タイムラインを正しい比率で描くのに要る
                    "filePath": path,
                    "playlists": playlists_by_track.get(str(t.ID), []),
                    "priority": in_priority,
                    "cues": cues,
                }
            )

    # 優先プレイリストの曲を先頭に
    tracks.sort(key=lambda x: (not x["priority"], x["title"]))
    return {"tracks": tracks, "outOfScope": out_of_scope}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    opts = config.rekordbox_options()
    ap.add_argument("--only", default=opts["folderFilter"] or "",
                    help="このパス片を含む曲だけ出力（既定: config.json の rekordbox.folderFilter。空文字で全曲）")
    ap.add_argument("--scope", default=",".join(opts["scopePlaylists"] or []),
                    help="このプレイリスト/フォルダ配下の曲だけ出力（カンマ区切り。既定: rekordbox.scopePlaylists。"
                         "指定すると --only は使わない）")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    if not (RB_DIR / "master.db").exists():
        print(f"master.db が見つかりません: {RB_DIR}（環境変数 REKORDBOX_DIR で場所を指定できます）", file=sys.stderr)
        return 1

    scope = [x.strip() for x in args.scope.split(",") if x.strip()] or None
    try:
        data = export(args.only or None, scope)
    except ScopeError as e:
        print(e, file=sys.stderr)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    n_cues = sum(len(t["cues"]) for t in data["tracks"])
    n_hot = sum(1 for t in data["tracks"] for c in t["cues"] if c["kind"] == "hot")
    n_pri = sum(1 for t in data["tracks"] if t["priority"])
    pri = f"（{PRIORITY_PLAYLIST} = {n_pri}曲）" if PRIORITY_PLAYLIST else ""
    print(f"{len(data['tracks'])} 曲{pri}/ {n_cues} キュー（ホット {n_hot}）-> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
