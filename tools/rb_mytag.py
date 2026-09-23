#!/usr/bin/env python3
"""ジャンル欄に入っていた「原曲の分類」を rekordbox の My Tag へ移す。

ジャンル欄は1曲に1つしか入らないので、**音の種類**（Frenchcore / Hardcore …）と
**原曲の分類**（アニメ / VOCALOID …）が同じ欄で取り合っていた。My Tag はカテゴリを持てて
1曲に複数付けられるので、原曲の分類はそちらへ移し、ジャンル欄は音の種類だけにする。

- My Tag のカテゴリは rekordbox の画面上4列で固定。**使っていない4列目
  （初期名 `Untitled Column`）を `原曲` に改名して使う**（新しい列は足せない）
- 移すのは `MOVE` に書いたジャンルだけ（本人確認済み 2026-09-22）。
  `Pop` / `J-Pop` / `Rock` の曲はリミックスではない原曲そのものなので、
  音の種類としても正しい = ジャンル欄に残す
- 曲とタグを結ぶ行（djmdSongMyTag）は pyrekordbox に作る関数が無いので、
  プレイリストの行（`add_to_playlist`）と同じ作り方で作る: ID/UUID は uuid4、
  TrackNo はそのタグの中での並び順

二度流しても、付いているタグは付け直さない・空のジャンルは空のまま（差分が出ないだけ）。

    ./.venv/bin/python tools/rb_mytag.py            # コピーで試すだけ
    ./.venv/bin/python tools/rb_mytag.py --apply    # 実機に書く（rekordbox を終了してから）

`--plan <表.json>` なら、人が確かめた分類表どおりに原曲タグを足す（アニメ / VOCALOID /
J-POP / K-POP / クラシック / 東方 / インターネット音楽 …。無いタグは作る）。
表は個人データなので `data/` に置く（git に入れない）。

    ./.venv/bin/python tools/rb_mytag.py --plan data/mytag_plan.json [--apply]
"""
import argparse, json, pathlib, sys, tempfile
from datetime import datetime
from uuid import uuid4

sys.path.insert(0, "tools")
import rb_export
from pyrekordbox import Rekordbox6Database
from pyrekordbox.db6 import tables

CATEGORY = "原曲"
# 4列目の初期名。これを CATEGORY に改名して使う
UNUSED_CATEGORY = "Untitled Column"

# 今のジャンル名 -> 原曲カテゴリに付けるタグ名。移した曲のジャンル欄は空にする
MOVE = {
    "アニメ": "アニメ",
    "VOCALOID": "VOCALOID",
}


def category(db) -> tables.DjmdMyTag:
    roots = {t.Name: t for t in db.get_my_tag() if t.ParentID == "root"}
    if CATEGORY in roots:
        return roots[CATEGORY]
    if UNUSED_CATEGORY not in roots:
        raise SystemExit(f"My Tag の空き列（{UNUSED_CATEGORY}）が見つかりません: {list(roots)}")
    cat = roots[UNUSED_CATEGORY]
    print(f"My Tag の列名  {cat.Name!r} → {CATEGORY!r}")
    cat.Name = CATEGORY
    return cat


def tag(db, cat: tables.DjmdMyTag, name: str) -> tables.DjmdMyTag:
    children = sorted((t for t in db.get_my_tag() if t.ParentID == str(cat.ID)), key=lambda t: t.Seq or 0)
    for t in children:
        if t.Name == name:
            return t
    # 初期値の `My Comment` はどの曲にも付いていない置き物。最初の1つはそれを改名して使う
    for t in children:
        if t.Name == "My Comment" and db.get_my_tag_songs(MyTagID=t.ID).count() == 0:
            print(f"My Tag         {t.Name!r} → {name!r}（{CATEGORY}）")
            t.Name = name
            return t
    new = tables.DjmdMyTag.create(
        ID=str(db.generate_unused_id(tables.DjmdMyTag)),
        Seq=len(children) + 1,
        Name=name,
        Attribute=0,
        ParentID=str(cat.ID),
        UUID=str(uuid4()),
    )
    db.add(new)
    db.flush()
    print(f"My Tag を作成  {name!r}（{CATEGORY}）")
    return new


def attach(db, t: tables.DjmdMyTag, c, have: set[str]) -> bool:
    """曲にタグを付ける。付いていれば何もしない（False）。have はそのタグの曲ID の集合"""
    if str(c.ID) in have:
        return False
    now = datetime.now()
    db.add(tables.DjmdSongMyTag.create(
        ID=str(uuid4()),
        MyTagID=str(t.ID),
        ContentID=str(c.ID),
        TrackNo=len(have) + 1,
        UUID=str(uuid4()),
        created_at=now,
        updated_at=now,
    ))
    have.add(str(c.ID))
    return True


def run_plan(db, cat: tables.DjmdMyTag, plan: pathlib.Path) -> int:
    """分類表（`[{id, title, plan: [タグ名…]}]`）どおりに原曲タグを**足す**。外しはしない"""
    tags: dict[str, tuple[tables.DjmdMyTag, set[str]]] = {}
    n = 0
    for row in json.loads(plan.read_text()):
        c = db.get_content(ID=row["id"])
        if c is None:
            print(f"  ! 曲が見つかりません: {row['id']} {row['title']}")
            continue
        added = []
        for name in row["plan"]:
            if name not in tags:
                t = tag(db, cat, name)
                tags[name] = (t, {s.ContentID for s in db.get_my_tag_songs(MyTagID=t.ID)})
            if attach(db, tags[name][0], c, tags[name][1]):
                added.append(name)
        if added:
            n += 1
            print(f"[{n}] {c.Title}  + {', '.join(added)}")
    return n


def run(db_path: pathlib.Path, apply: bool, plan: pathlib.Path | None = None) -> int:
    # `path=` で開く（`db_dir=` は効かず実機が開かれる。fix_rb_tags.py の注意と同じ）
    db = Rekordbox6Database(path=str(db_path), unlock=True)
    cat = category(db)
    if plan:
        n = run_plan(db, cat, plan)
        if apply:
            db.commit()
            print(f"\n✓ {n} 曲にタグを足しました")
        else:
            print(f"\n（コピーでの試行）{n} 曲にタグが足されます。--apply で実機に書きます")
        return n
    n = 0
    for genre, name in MOVE.items():
        songs = [c for c in db.get_content() if c.Genre and c.Genre.Name == genre]
        if not songs:
            continue
        t = tag(db, cat, name)
        have = {s.ContentID for s in db.get_my_tag_songs(MyTagID=t.ID)}
        for c in songs:
            n += 1
            print(f"[{n}] {c.Title}")
            if attach(db, t, c, have):
                print(f"      My Tag      + {CATEGORY}/{name}")
            print(f"      ジャンル     {genre!r} → ''")
            c.GenreID = None
    if apply:
        db.commit()
        print(f"\n✓ {n} 曲を master.db に書きました")
    else:
        print(f"\n（コピーでの試行）{n} 曲が変わります。--apply で実機に書きます")
    return n


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="実機の master.db に書く")
    ap.add_argument("--plan", type=pathlib.Path, help="分類表（JSON）どおりに原曲タグを足す")
    args = ap.parse_args()
    if args.apply:
        run(rb_export.RB_DIR / "master.db", True, args.plan)
    else:
        run(rb_export.copy_db(pathlib.Path(tempfile.mkdtemp())), False, args.plan)
