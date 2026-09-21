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
import sys, argparse, tempfile, pathlib, unicodedata
sys.path.insert(0, 'tools')
import rb_export
from pyrekordbox import Rekordbox6Database

# 現タイトル -> {title, artist, genre}。指定した項目だけ変える（None は触らない）
# genre="" はジャンルを外す
CHANGES = {
    # ── 2026-09-22 第4回: ジャンルの表記ゆれ（本人に確認済み）──
    # /play の除外条件でジャンルを選ぶので、同じジャンルが別々に並ばないように揃える。
    # VOCALOID はヤマハの正式表記に寄せる（vocaloid 2曲 / Vocaloid 1曲 → VOCALOID）
    "いーあるふぁんくらぶ（Giga-P remix）": {"genre": "VOCALOID"},
    "裏表ラバーズ（電蝕システムリミックス）": {"genre": "VOCALOID"},
    "こちら、幸福安心委員会です。 (Imperative Mix)": {"genre": "VOCALOID"},
    # Hardcore / UK Hardcore とは別のサブジャンルとして残し、大文字小文字だけ他と揃える
    "カゲロウデイズ（RAVERS SQUAD bootleg）": {"genre": "Hardcore Rave"},
    # ジャンルではない値を外す（ㅁㄴㄹ はキーボードの打ち間違い、Remix は種別）。
    # 音の種類の根拠が無いので、推測で埋めずに空にする
    "ゴーストルール（DIVELA remix）": {"genre": ""},
    "ワールズエンド・ダンスホール（TEKINA remix）": {"genre": ""},
}


def run(db_path: pathlib.Path, apply: bool) -> int:
    # **`path=` で開く。`db_dir=` は効かず、既定の場所（実機）が開かれる**
    # （実測 2026-09-09: コピーを渡したつもりの commit が実機に書き込まれた）。
    # `rb_export` も `path=` を使っている。ここを間違えると、試すつもりの実行が本番になる。
    db = Rekordbox6Database(path=str(db_path), unlock=True)
    # 実機の曲名は NFD（バ = ハ＋濁点）で入っていることがある。見た目が同じでも
    # 文字列が一致しないので、NFC に揃えてから引く（実測 2026-09-22: 裏表ラバーズ）
    nfc = lambda t: unicodedata.normalize("NFC", t)
    by_title = {}
    for c in db.get_content():
        by_title.setdefault(nfc(c.Title or ""), []).append(c)

    missing = [t for t in CHANGES if nfc(t) not in by_title]
    dup = [t for t in CHANGES if len(by_title.get(nfc(t), [])) > 1]
    if missing:
        print("⚠ 見つからない曲（実機で既に直された？）:")
        for t in missing: print(f"    {t}")
    if dup:
        print("⚠ 同じタイトルが複数あるので触りません:")
        for t in dup: print(f"    {t}")

    n = 0
    for title, want in CHANGES.items():
        rows = by_title.get(nfc(title), [])
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
