#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sync の結び直し（rekey）・数の比べ方（same_value）・記号の対応（cue_letter）を偽データで確かめる。

    ./.venv/bin/python tools/test_sync_rekey.py

pytest は要らない（素の assert）。Notion にも master.db にも触らない — 設定は空の一時ディレクトリと
偽の database ID に差し替え、Notion を叩く関数は呼ばれたら落ちるようにしてある。
"""
from __future__ import annotations

import builtins
import os
import sys
import tempfile
from pathlib import Path

# 本物の設定・トークンを読ませない（import より前に差し替える）
os.environ["REKORD_GRAPH_CONFIG_DIR"] = tempfile.mkdtemp()
for key in ("TRACKS", "CUES", "TRANSITIONS", "LAYOUTS"):
    os.environ[f"NOTION_DB_{key}"] = f"fake-{key.lower()}"
os.environ.pop("REKORDBOX_SCOPE_PLAYLISTS", None)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import notion_api as na  # noqa: E402
import rb_export  # noqa: E402
import sync  # noqa: E402


def _no_network(*_a, **_k):
    raise AssertionError("テストが Notion を叩こうとした")


na.request = _no_network
na.query_all = _no_network

# 曲ID -> 曲ページID（rekey は削除側の曲ページを rekordbox の曲ID に引き直す）
sync._TRACK_PAGES = {"T1": "page-t1", "T2": "page-t2"}
sync._TRANSITIONS = []


def nt_row(page: str, letter: str, name: str, pos: int, track_page: str = "page-t1") -> dict:
    return {"pageId": page, "title": f"x / {letter}「{name}」", "letter": letter, "name": name,
            "positionMs": pos, "loop": False, "loopEndMs": None, "trackPageId": track_page}


def rb_row(letter: str, name: str, pos: int, track: str = "T1") -> dict:
    return {"trackId": track, "trackTitle": "x", "title": f"x / {letter}「{name}」", "letter": letter,
            "name": name, "positionMs": pos, "loop": False, "loopEndMs": None, "priority": False}


def add(uuid: str, r: dict) -> dict:
    return {"kind": "add", "uuid": uuid, "rb": r, "summary": r["title"]}


def delete(uuid: str, n: dict) -> dict:
    return {"kind": "delete", "uuid": uuid, "notion": n, "summary": n["title"]}


def run(plan: list[dict]) -> list[dict]:
    sync.rekey(plan)
    return plan


def kinds(plan: list[dict]) -> list[str]:
    return sorted(p["kind"] for p in plan)


def test_rekey_position_and_name() -> None:
    # メモリーキュー→ホットキュー変換: UUID と記号が変わるが位置と名前は同じ → 同じ行に結び直す
    plan = run([delete("old", nt_row("c1", "F", "1サビ終", 1000)), add("new", rb_row("G", "1サビ終", 1000))])
    assert kinds(plan) == ["rekey"], plan
    r = plan[0]
    assert r["uuid"] == "new" and r["notion"]["pageId"] == "c1"
    assert r["why"] == "位置とキュー名が一致"
    assert ("記号", "F", "G") in r["changes"]


def test_rekey_same_name_picks_by_letter() -> None:
    # 同じ位置・同じ名前が2つ → 記号で選ぶ（記号はタイブレークにだけ使う）
    plan = run([
        delete("o1", nt_row("c1", "D", "1サビ終", 2000)), delete("o2", nt_row("c2", "F", "1サビ終", 2000)),
        add("n1", rb_row("F", "1サビ終", 2000)),
    ])
    rk = [p for p in plan if p["kind"] == "rekey"]
    assert len(rk) == 1 and rk[0]["notion"]["pageId"] == "c2", plan
    assert "記号で選択" in rk[0]["why"]
    assert [p["notion"]["pageId"] for p in plan if p["kind"] == "delete"] == ["c1"]


def test_rekey_same_name_picks_referenced_row() -> None:
    # 同位置同名が2つ消え、記号でも選べない → 🔀Transitions から参照されている方を生かす
    sync._TRANSITIONS = [{"id": "tr1", "properties": {"Fromキュー": {"relation": [{"id": "c-2"}]}}}]
    try:
        plan = run([
            delete("o1", nt_row("c1", "E", "1サビ終ル", 3000)), delete("o2", nt_row("c-2", "F", "1サビ終ル", 3000)),
            add("n1", rb_row("D", "1サビ終ル", 3000)),
        ])
    finally:
        sync._TRANSITIONS = []
    rk = [p for p in plan if p["kind"] == "rekey"]
    assert len(rk) == 1 and rk[0]["notion"]["pageId"] == "c-2", plan
    assert "繋ぎから参照" in rk[0]["why"]


def test_rekey_position_only_and_prefix() -> None:
    # 位置が一意なら名前が違っても結ぶ
    plan = run([delete("o", nt_row("c1", "A", "助走", 500)), add("n", rb_row("A", "イントロ", 500))])
    assert kinds(plan) == ["rekey"] and plan[0]["why"] == "位置が一致"
    # 同じ位置に2つずつ（位置だけでは決まらない）でも、前方一致が一意なら結ぶ
    plan = run([
        delete("o1", nt_row("c1", "A", "1サビ終受け", 500)), delete("o2", nt_row("c2", "B", "2歌入り", 500)),
        add("n1", rb_row("A", "1サビ終", 500)), add("n2", rb_row("B", "ラス", 500)),
    ])
    rk = {p["notion"]["pageId"]: p for p in plan if p["kind"] == "rekey"}
    assert "c1" in rk and rk["c1"]["why"] == "位置が一致し、キュー名が前方一致", plan
    assert "c2" not in rk


def test_rekey_name_only_when_moved() -> None:
    # 位置を動かした（打ち直した）が名前が一意 → 名前で結ぶ
    plan = run([delete("o", nt_row("c1", "C", "ドロップ", 1000)), add("n", rb_row("C", "ドロップ", 1500))])
    assert kinds(plan) == ["rekey"] and plan[0]["why"] == "キュー名が一致（位置は動いている）"
    # 空白だけ違う名前
    plan = run([delete("o", nt_row("c1", "A", "1.1Bars", 50)), add("n", rb_row("A", "1.1 Bars", 1599))])
    assert kinds(plan) == ["rekey"] and "空白の違いを無視" in plan[0]["why"]


def test_rekey_ambiguous_stays_unmatched() -> None:
    # 位置も名前も別物 → 推測せず削除 + 追加のまま
    plan = run([delete("o", nt_row("c1", "A", "助走", 500)), add("n", rb_row("B", "ラス受け", 9000))])
    assert kinds(plan) == ["add", "delete"], plan
    # 同じ位置・同じ名前の追加が2つ（どちらが元の行か決まらない）→ 結ばない
    plan = run([
        delete("o", nt_row("c1", "A", "1サビ終", 700)),
        add("n1", rb_row("B", "1サビ終", 700)), add("n2", rb_row("C", "1サビ終", 700)),
    ])
    assert kinds(plan) == ["add", "add", "delete"], plan
    # 別の曲同士は位置と名前が同じでも結ばない
    plan = run([delete("o", nt_row("c1", "A", "1サビ終", 700, "page-t2")), add("n", rb_row("A", "1サビ終", 700, "T1"))])
    assert kinds(plan) == ["add", "delete"], plan


def test_same_value() -> None:
    assert sync.same_value(160, 160.0)
    assert sync.same_value(160.0, "160")  # 数が絡めば数として比べる
    assert not sync.same_value(160, 161)
    assert not sync.same_value(None, 160)
    assert sync.same_value(None, None)
    assert sync.same_value("", None)
    # 文字列は NFC で比べる（rekordbox は NFD のことがある）
    assert sync.same_value("グ", "グ")
    assert not sync.same_value("A", "B")


def test_cue_letter() -> None:
    cases = {None: None, 0: None, 1: "A", 2: "B", 3: "C", 4: None, 5: "D", 6: "E", 17: "P", 18: None}
    for kind, want in cases.items():
        got = rb_export.cue_letter(kind)
        assert got == want, (kind, got, want)


def test_approve_skips_cue_of_declined_track() -> None:
    # 「曲追加」を断ったら、その曲のキューの「追加」は承認しても書かない（以前は NotionError で全体が止まった）
    t_new = {"id": "T9", "title": "new", "shortName": "new"}
    items = [
        {"kind": "track_add", "uuid": "T9", "track": t_new, "summary": "new"},
        add("n9", rb_row("A", "x", 1, "T9")),
        add("n1", rb_row("A", "y", 1, "T1")),
    ]
    answers = iter(["n", "y"])  # 曲追加 = n、T1 のキュー = y（T9 のキューは聞かれない）
    real_input = builtins.input
    builtins.input = lambda *_a: next(answers)
    try:
        approved, skipped = sync.approve(items, yes=False)
    finally:
        builtins.input = real_input
    assert [p["uuid"] for p in approved] == ["n1"], approved
    assert [p["uuid"] for p in skipped] == ["n9"], skipped
    # --yes なら曲追加も通るので、キューも通る
    approved, skipped = sync.approve(items, yes=True)
    assert [p["uuid"] for p in approved] == ["T9", "n9", "n1"] and not skipped


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} 件すべて通りました")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
