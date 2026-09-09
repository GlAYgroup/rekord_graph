#!/usr/bin/env python3
"""rekordbox master.db のタグ（曲名・アーティスト・ジャンル）を直す。

**実機が唯一の正**なので、Notion（鏡）ではなくここを直す。直したあと
`tools/sync.py` を回せば 🎵Tracks に流れる。

形式:
  曲名        `原曲タイトル（リミキサー名 remix/bootleg/edit）`（全角括弧）
  アーティスト 原曲のアーティスト（リミキサーではない）
  ジャンル     曲名にジャンル名が入っていたらそれを入れる
  表記        英語 / 日本語は原曲のタイトルに合わせる

`CHANGES` は**その回に直す分の手書きリスト**。取り込みのたびに書き換えて使う。
既に直っている曲は差分が出ないだけなので、二度流しても壊れない。

    ./.venv/bin/python tools/fix_rb_tags.py            # コピーで試すだけ
    ./.venv/bin/python tools/fix_rb_tags.py --apply    # 実機に書く

**必ず rekordbox を終了させてから `--apply` する**（起動中に外から書くと壊れる）。
先に master.db をバックアップすること:

    cp -p ~/Library/Pioneer/rekordbox/master.db* ~/rekordbox_backup_$(date +%Y%m%d_%H%M%S)/
"""
import sys, argparse, tempfile, pathlib
sys.path.insert(0, 'tools')
import rb_export
from pyrekordbox import Rekordbox6Database

# 現タイトル -> {title, artist, genre}。指定した項目だけ変える（None は触らない）
# genre="" はジャンルを外す
CHANGES = {
    # ── 承認済みチェックリスト A: 形式から外れている曲名・アーティスト ──
    "Yasuo-P + Giga-P - えれくとりっく・えんじぇぅ (Altermis Hardcore Edit) [Free DL]":
        {"title": "えれくとりっく・えんじぇぅ（Altermis edit）", "artist": "ヤスオP・ギガP"},
    "ヤラララ(YARARARA)": {"title": "ヤラララ"},

    # ── 承認済みチェックリスト B: ジャンル（旧ファイル名に根拠あり）──
    "アイドル（Cosmowave remix）": {"genre": "Hardbass"},
    "Ievan Polkka（Cosmowave remix）": {"genre": "Hardbass"},          # Hard Bass から統一
    "キャンディークッキーチョコレート（K.zune remix）": {"genre": "Frenchcore"},
    "パンダヒーロー（SUZUNO bootleg）": {"genre": "Frenchcore"},
    "メズマライザー（Newlisk remix）": {"genre": "Frenchcore"},
    "ロミオとシンデレラ（ZEPHYR edit）": {"genre": "Frenchcore"},
    "混沌ブギ（SDF's bootleg）": {"genre": "Frenchcore"},
    "ローリンガール（Mede's bootleg）": {"genre": "Hardcore"},
    "モザイクロール（DAYOx2 bootleg）": {"genre": "UK Hardcore"},
    "星間飛行（A/I remix）": {"genre": "UK Hardcore"},
    "転生林檎（sasamin remix）": {"genre": "Hardtechno"},
    "ビビデバ（NAMA remix）": {"genre": "Fullcore"},
    "お返事まだカナ💦❓おじさん構文😁❗️（Cura remix）": {"genre": "Hardfunk"},
    "ダイダイダイダイダイキライ（PiEa remix）": {"genre": "Bassline Garage"},   # Other から
    "It's Me（HARRY bootleg）": {"genre": "Hi-Tech"},
    "小フーガ ト短調 BWV 578": {"genre": "Classical"},                  # Other から

    # ── 新規取り込み分: 形式に合わせる（アーティストは原曲者へ）──
    "Amala - ダイダイダイダイダイキライ (KAUTSAR Remix)2":
        {"title": "ダイダイダイダイダイキライ（KAUTSAR remix）", "artist": "雨良 Amala"},
    "DECO*27 - ゴーストルール feat. 初音ミク (Tr!xy Euphoric Frenchcore Bootleg)":
        {"title": "ゴーストルール（Tr!xy bootleg）", "artist": "DECO*27", "genre": "Frenchcore"},
    "Tell Your World (Snail's House Remix) [all my love to this world VIP]":
        {"title": "Tell Your World（Snail's House remix）", "artist": "kz(livetune)", "genre": ""},
    "doriko feat.初音ミク - ロミオとシンデレラ (Zekk Remix)":
        {"title": "ロミオとシンデレラ（Zekk remix）", "artist": "doriko"},
    "いますぐ輪廻(Gyr0 Remix)": {"title": "いますぐ輪廻（Gyr0 remix）", "artist": "なきそ"},
    "エイリアンエイリアン(wotaku Remix)":
        {"title": "エイリアンエイリアン（wotaku remix）", "artist": "ナユタン星人"},
    "トウキョウ・シャンディ・ランデヴ(DJSC donk bootleg)":
        {"title": "トウキョウ・シャンディ・ランデヴ（DJSC bootleg）", "artist": "Kanaria", "genre": "Donk"},
    "ハッピーシンセサイザ(HISASHIz Bootleg Remix)":
        {"title": "ハッピーシンセサイザ（HISASHIz bootleg）"},
    "乙女解剖 (kaputt Remix)": {"title": "乙女解剖（kaputt remix）", "artist": "DECO*27"},
    "千本桜 feat. 初音ミク (Yasuha. Remix)": {"title": "千本桜（Yasuha. remix）", "artist": "黒うさP"},
    "みむかｩわナイストライ (Hexacube's HARDCORE-style Bootleg)": {"genre": "Hardcore"},
}


def run(db_path: pathlib.Path, apply: bool) -> int:
    # **`path=` で開く。`db_dir=` は効かず、既定の場所（実機）が開かれる**
    # （実測 2026-09-09: コピーを渡したつもりの commit が実機に書き込まれた）。
    # `rb_export` も `path=` を使っている。ここを間違えると、試すつもりの実行が本番になる。
    db = Rekordbox6Database(path=str(db_path), unlock=True)
    by_title = {}
    for c in db.get_content():
        by_title.setdefault(c.Title or "", []).append(c)

    missing = [t for t in CHANGES if t not in by_title]
    dup = [t for t in CHANGES if len(by_title.get(t, [])) > 1]
    if missing:
        print("⚠ 見つからない曲（実機で既に直された？）:")
        for t in missing: print(f"    {t}")
    if dup:
        print("⚠ 同じタイトルが複数あるので触りません:")
        for t in dup: print(f"    {t}")

    n = 0
    for title, want in CHANGES.items():
        rows = by_title.get(title, [])
        if len(rows) != 1:
            continue
        c = rows[0]
        lines = []
        if "title" in want and c.Title != want["title"]:
            lines.append(f"曲名        {c.Title!r} → {want['title']!r}")
            c.Title = want["title"]
        if "artist" in want:
            cur = c.Artist.Name if c.Artist else ""
            if cur != want["artist"]:
                lines.append(f"アーティスト {cur!r} → {want['artist']!r}")
                a = db.get_artist(Name=want["artist"]).one_or_none() or db.add_artist(want["artist"])
                c.ArtistID = str(a.ID)
        if "genre" in want:
            cur = c.Genre.Name if c.Genre else ""
            if cur != want["genre"]:
                lines.append(f"ジャンル     {cur!r} → {want['genre']!r}")
                if want["genre"]:
                    g = db.get_genre(Name=want["genre"]).one_or_none() or db.add_genre(want["genre"])
                    c.GenreID = str(g.ID)
                else:
                    c.GenreID = None
        if lines:
            n += 1
            print(f"\n[{n}] {title}")
            for l in lines: print(f"      {l}")

    if apply:
        db.commit()
        print(f"\n✓ {n} 曲を master.db に書きました")
    else:
        print(f"\n（コピーでの試行）{n} 曲が変わります。--apply で実機に書きます")
    return n


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="実機の master.db に書く")
    args = ap.parse_args()
    if args.apply:
        run(rb_export.RB_DIR / "master.db", True)
    else:
        tmp = pathlib.Path(tempfile.mkdtemp())
        run(rb_export.copy_db(tmp), False)  # copy_db はコピー先のパスを返す
