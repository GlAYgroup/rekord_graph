#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rekordbox master.db の曲名・アーティスト・ジャンルを、修正表どおりに直す。

**実機が唯一の正**なので、Notion（鏡）ではなくここを直す。直したあと
`tools/sync.py` を回せば「曲更新」として 🎵Tracks に流れる。

    ./.venv/bin/python tools/rb_tags.py --audit        # 形式から外れた曲・原曲の分類が無い曲を並べる（読むだけ）
    ./.venv/bin/python tools/rb_tags.py --find ベノム  # ContentID を調べる（読むだけ）
    ./.venv/bin/python tools/rb_tags.py --dry-run      # 出すだけ。何も書かない
    ./.venv/bin/python tools/rb_tags.py                # 1件ずつ y/n/a/q で確認
    ./.venv/bin/python tools/rb_tags.py --yes          # 全件承認（内容を確認済みのときだけ）

修正表は `data/tag_fixes.json`（個人データなので git に入れない）:

    {"entries": [
      {"id": "149146464",                        # rekordbox の ContentID（曲名ではなくこれで引く）
       "current_title": "Bad Apple (Cosmowave Remix)",  # 表を作ったときの実機の曲名（取り違え防止）
       "title": "Bad Apple!!（Cosmowave remix）",  # 書きたい値。書かない項目はキーごと省く
       "artist": "Masayoshi Minoshima feat. nomico",
       "genre": "Hardbass",                       # "" はジャンルを空にする
       "status": "ok",                            # "ok" だけ書く。"check" は人の確認待ち
       "note": "根拠"}
    ]}

以前は `rb_retitle.py`（曲名・アーティスト。ContentID 指定）と `fix_rb_tags.py`
（曲名・アーティスト・ジャンル。曲名指定・コード内に手書き）の2本だった。
曲名指定は同名曲を直せず、バックアップも起動中の拒否も無かったので、こちらに寄せた。

master.db への直接書き込みは Pioneer 非公式なので、安全側に倒す:
- 書き込み前に master.db / -wal / -shm を丸ごとバックアップする（必須・スキップ不可）
- rekordbox が起動中なら書き込みを拒否する（--dry-run / --find はコピーを読むので可）
- 実機の曲名が `current_title` とも書きたい `title` とも違う行は書かずに警告する
  （表を作った後に実機で別の直し方をした = 表が古い）
- 既に書きたい値になっている項目は書かない（二度流しても差分が出ないだけ）
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import re
import tempfile
import unicodedata
from datetime import datetime
from pathlib import Path

RB_DIR = Path.home() / "Library/Pioneer/rekordbox"
BACKUP_ROOT = Path.home() / "Library/Pioneer/rekordbox_backups_rekord_graph"
MAP_PATH = Path(__file__).resolve().parent.parent / "data" / "tag_fixes.json"
FIELDS = ("title", "artist", "genre")
LABEL = {"title": "曲名", "artist": "アーティスト", "genre": "ジャンル"}


def nfc(s: str | None) -> str:
    # macOS 由来のタイトルは濁点が分解形（ク+゙）で入っているので、比較は必ず NFC で
    return unicodedata.normalize("NFC", s or "")


def rekordbox_running() -> bool:
    return subprocess.run(["pgrep", "-x", "rekordbox"], capture_output=True).returncode == 0


def backup() -> Path:
    dest = BACKUP_ROOT / datetime.now().strftime("%Y%m%d-%H%M%S")
    dest.mkdir(parents=True)
    for suffix in ("", "-wal", "-shm"):
        src = RB_DIR / f"master.db{suffix}"
        if src.exists():
            shutil.copy2(src, dest / f"master.db{suffix}")
    return dest


def open_db(copy: bool):
    from pyrekordbox import Rekordbox6Database

    if not copy:
        return Rekordbox6Database(unlock=True), None
    # 読むだけなので実ファイルは開かない（rekordbox 起動中でも安全）。
    # **`path=` で開く。`db_dir=` は効かず実機が開かれる**（実測 2026-09-09: コピーのつもりが実機に書いた）
    tmp = tempfile.TemporaryDirectory()
    for suffix in ("", "-wal", "-shm"):
        src = RB_DIR / f"master.db{suffix}"
        if src.exists():
            shutil.copy2(src, Path(tmp.name) / f"master.db{suffix}")
    return Rekordbox6Database(path=str(Path(tmp.name) / "master.db"), unlock=True), tmp


def live_values(cont) -> dict[str, str]:
    return {
        "title": nfc(cont.Title),
        "artist": nfc(cont.Artist.Name if cont.Artist else ""),
        "genre": nfc(cont.Genre.Name if cont.Genre else ""),
    }


def load_map(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))["entries"]


def build_plan(db, entries: list[dict]) -> tuple[list[dict], list[str]]:
    """修正表と実機を突き合わせ、書く項目 / 書けない理由 に分ける。"""
    plan, warns = [], []
    for e in entries:
        if e.get("status", "ok") != "ok":
            continue
        cont = db.get_content(ID=str(e["id"]))  # ID 指定時は object か None が返る
        if cont is None:
            warns.append(f"曲が見つからない: {e['id']} {e.get('current_title')!r}（削除された?）")
            continue
        live = live_values(cont)
        writes = {f: e[f] for f in FIELDS if f in e and e[f] is not None and live[f] != nfc(e[f])}
        if not writes:
            continue  # 反映済み。書いた後の実機は current_title と違って当然なので、ずれ検査より先に見る
        # 実機の曲名が「表を作ったときの曲名」でも「書きたい曲名」でもない = 表を作った後に
        # 実機で別の直し方をした。その表のまま書くと直したものを戻しうるので書かない
        known = {nfc(e.get("current_title")), nfc(e.get("title"))} - {""}
        if known and live["title"] not in known:
            warns.append(
                f"修正表を作った後に実機の曲名が変わっている: {e['id']}\n"
                f"    修正表: {e.get('current_title')!r}\n"
                f"    実機:   {cont.Title!r}\n"
                f"    → この行は書かない。修正表の current_title を直すこと"
            )
            continue
        plan.append({"content": cont, "entry": e, "live": live, "writes": writes})
    return plan, warns


def show(item: dict, i: int, total: int) -> None:
    print(f"\n[{i}/{total}] {item['content'].Title}  (ID {item['entry']['id']})")
    for f, v in item["writes"].items():
        print(f"    {LABEL[f]}:  {item['live'][f] or '（空）'}  →  {v or '（空）'}")


def get_or_create(db, kind: str, name: str, cache: dict):
    key = (kind, name)
    if key not in cache:
        getter, adder = (db.get_artist, db.add_artist) if kind == "artist" else (db.get_genre, db.add_genre)
        row = getter(Name=name).first()
        if row is None:
            row = adder(name)
            print(f"    {LABEL[kind]}の行を新規作成: {name}")
        cache[key] = row
    return cache[key]


def write(db, item: dict, cache: dict) -> None:
    cont = item["content"]
    for f, v in item["writes"].items():
        if f == "title":
            cont.Title = v
        elif not v:
            setattr(cont, "ArtistID" if f == "artist" else "GenreID", None)  # "" は空にする
        else:
            row = get_or_create(db, f, v, cache)
            setattr(cont, "ArtistID" if f == "artist" else "GenreID", str(row.ID))


def find(db, words: list[str]) -> None:
    ws = [nfc(w).lower() for w in words]
    hits = 0
    for c in db.get_content():
        v = live_values(c)
        hay = " ".join([v["title"], v["artist"], v["genre"], nfc(c.FolderPath)]).lower()
        if all(w in hay for w in ws):
            hits += 1
            print(f"{c.ID}\t{v['title']}\t{v['artist'] or '（空）'}\t{v['genre'] or '（空）'}")
    print(f"\n{hits} 件（ContentID / 曲名 / アーティスト / ジャンル）")


# 形式（`原曲タイトル（リミキサー remix）`）から外れている印。**見て分かることだけ**を拾い、
# 原曲名やアーティストの推測はしない（それは人・調べものの仕事）
REMIX_WORD = re.compile(r"(remix|bootleg|edit|flip|mix\b|vip|mashup|rework)", re.I)
SHAPE_CHECKS = [
    (re.compile(r"[()\[\]]"), "半角の括弧"),
    (re.compile(r"[【】]"), "【】の装飾"),
    (re.compile(r"\s[-–—]\s"), "「アーティスト - 曲名」の形"),
    (re.compile(r"\b(feat|ft)\.", re.I), "feat. が曲名に入っている"),
    (re.compile(r"_"), "アンダースコア（ファイル名のまま）"),
    (re.compile(r"free\s*(dl|download)|extended mix|\+vsqx", re.I), "配布元の飾り"),
]


def title_problems(title: str) -> list[str]:
    t = nfc(title)
    out = [why for rx, why in SHAPE_CHECKS if rx.search(t)]
    outside = re.sub(r"（[^）]*）", "", t)  # 全角括弧の外にリミックス語がある = 括弧に入っていない
    if REMIX_WORD.search(outside):
        out.append("リミックス名が全角括弧に入っていない")
    return out


def audit(entries: list[dict]) -> None:
    """同期対象の曲のうち、形式・アーティスト・原曲の分類が揃っていないものを並べる（読むだけ）。
    新しく取り込んだ曲は旧ファイル名のまま入ってくるので、取り込みのたびにこれで拾う"""
    import config
    import rb_export

    queued = {str(e["id"]): e.get("status", "ok") for e in entries}
    tracks = rb_export.export(config.rekordbox_options()["folderFilter"])["tracks"]
    rows = []
    for t in tracks:
        why = title_problems(t["title"])
        if not (t["artist"] or "").strip():
            why.append("アーティストが空")
        if not any(tag.startswith("原曲/") for tag in t["myTags"]):
            why.append("原曲の分類（My Tag）なし")
        if why:
            rows.append((t, why))
    for t, why in rows:
        mark = {"ok": "［修正表にあり］", "check": "［修正表: 確認待ち］"}.get(queued.get(t["id"]), "")
        print(f"\n{t['id']}  {t['title']}  {mark}")
        print(f"    アーティスト: {t['artist'] or '（空）'} / ジャンル: {t['genre'] or '（空）'} / "
              f"My Tag: {', '.join(t['myTags']) or '（なし）'}")
        for w in why:
            print(f"    - {w}")
    print(f"\n{len(rows)} 曲（同期対象 {len(tracks)} 曲のうち）")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="差分を出すだけ。何も書き込まない")
    ap.add_argument("--yes", action="store_true", help="全件承認する（内容を確認済みのときだけ）")
    ap.add_argument("--find", nargs="+", metavar="語", help="曲名・アーティスト・ジャンル・パスで曲を探す（読むだけ）")
    ap.add_argument("--audit", action="store_true", help="形式・アーティスト・原曲の分類が揃っていない曲を並べる（読むだけ）")
    ap.add_argument("--map", type=Path, default=MAP_PATH, help=f"修正表（既定: {MAP_PATH}）")
    args = ap.parse_args()

    if not (RB_DIR / "master.db").exists():
        print(f"master.db が見つかりません: {RB_DIR}", file=sys.stderr)
        return 1

    if args.audit:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        audit(load_map(args.map) if args.map.exists() else [])
        return 0

    readonly = args.dry_run or bool(args.find)
    if not readonly and rekordbox_running():
        print("rekordbox が起動中です。終了してから実行してください（--dry-run なら可）。", file=sys.stderr)
        return 1

    print("rekordbox master.db を開いています…")
    db, tmp = open_db(copy=readonly)
    try:
        if args.find:
            find(db, args.find)
            return 0

        entries = load_map(args.map)
        n_check = sum(1 for e in entries if e.get("status", "ok") != "ok")
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
            print(f"\n--dry-run のため何も書き込みませんでした（対象 {len(plan)} 曲）。")
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
        print(f"{len(approved)} 曲を master.db に書き込みます…")
        cache: dict = {}
        for item in approved:
            write(db, item, cache)
        db.commit()
        print("完了。rekordbox を起動して表示を確認してください。")
        print("次: ./.venv/bin/python tools/sync.py --dry-run（「曲更新」として出る）")
        return 0
    finally:
        db.close()
        if tmp:
            tmp.cleanup()


if __name__ == "__main__":
    sys.exit(main())
