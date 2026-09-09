#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rekordbox の変更を検出して、承認された分だけ Notion 📍Cues に反映する。

    ./.venv/bin/python tools/sync.py            # 差分を出して1件ずつ承認
    ./.venv/bin/python tools/sync.py --dry-run  # 出すだけ。何も書かない
    ./.venv/bin/python tools/sync.py --yes      # 全部承認（内容を確認済みのときだけ）

★ 前提: キュー名（Notion の「」の中身）が正、アルファベットは信用しない。
   だから照合は名前でもアルファベットでもなく、**rekordbox のキュー UUID** で行う。
   UUID は名前や記号を変えても不変なので、「似ているから同じだろう」という推測が要らない。

★ ただし UUID が変わる操作がある。
   キューを消して作り直したとき、「メモリーキュー→ホットキュー変換」をしたときは
   **新しい UUID の別行**になる。UUID だけで見ると「削除 + 追加」に見え、
   Notion のキュー行を作り直すことになる = **その行を参照している 🔀Transitions が壊れる**。

   そこで **位置（ms）を第二のキー**にする。名前も記号も変わるが、
   曲の中のどこを指しているかは変わらないため（実測: メモリーキュー 192件すべてが
   同じ位置のホットキューを持っていた = 変換で位置は 1ms も動かない）。

   位置は曲の中で一意ではない（実測: 54曲中 24曲で同じ位置に複数のホットキューがある。
   `A 1.1Bars` と `B 1.1Bars` のような重なりが典型）。だから位置だけでは決めない:
     1. 位置とキュー名が一致  → いちばん確か
     2. 位置が一致し、その位置の候補が両側で1つだけ
     3. キュー名が一致し、候補が1つだけ（位置を動かした場合）
   どれにも当てはまらないものは推測せず、追加/削除のまま人に見せる。

★ 既定は「何もしない」。承認された項目だけ書き込む。
"""
from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import notion_api as na
import rb_export
from gen_cue_payload import build_short_names, ms_to_str

CUES = na.CONFIG["cues"]


def nfc(s: str | None) -> str:
    """比較用に Unicode 正規化する。

    rekordbox の文字列は macOS 由来で NFD（濁点が分離）のことがあり、
    Notion は NFC で返す。素朴に比較すると「柊マグネタイト」等が
    毎回「変更あり」に見えてしまうため、必ずここを通す。
    """
    return unicodedata.normalize("NFC", s or "")


# 📍Cues に無ければ生やす列。ループは rekordbox が正なので、鏡である Cues に載せる
LOOP_COLUMNS = {"ループ": {"checkbox": {}}, "ループ終ms": {"number": {}}}

# 🎵Tracks に無ければ生やす列。ジャンルも実機で分類するものなので、鏡に載せる
TRACK_COLUMNS = {"ジャンル": {"rich_text": {}}}


def ensure_loop_columns() -> None:
    """📍Cues に「ループ」「ループ終ms」列が無ければ足す。

    書き込む直前に1回だけ呼ぶ。列が無いまま値を送ると Notion が丸ごと弾くので、
    「初回の sync だけ列が生える」形にして、人が Notion を触らなくて済むようにする。
    """
    db = na.request("GET", f"/databases/{CUES}")
    missing = {k: v for k, v in LOOP_COLUMNS.items() if k not in (db.get("properties") or {})}
    if not missing:
        return
    print(f"📍Cues に列を追加します: {' / '.join(missing)}")
    na.request("PATCH", f"/databases/{CUES}", {"properties": missing})


def ensure_track_columns() -> None:
    """🎵Tracks に足りない列を生やす。`ensure_loop_columns` と同じ理由・同じ流儀。"""
    db = na.request("GET", f"/databases/{na.CONFIG['tracks']}")
    missing = {k: v for k, v in TRACK_COLUMNS.items() if k not in (db.get("properties") or {})}
    if not missing:
        return
    print(f"🎵Tracks に列を追加します: {' / '.join(missing)}")
    na.request("PATCH", f"/databases/{na.CONFIG['tracks']}", {"properties": missing})


def loop_props(r: dict) -> dict:
    """書き込む側のループ列。ループでなければ空にする（前がループだった行を戻すため）"""
    return {
        "ループ": {"checkbox": bool(r.get("loop"))},
        "ループ終ms": {"number": r.get("loopEndMs")},
    }


def loop_changes(n: dict, r: dict) -> list[tuple[str, str, str]]:
    """ループの差分。ループになった/やめたは押し方が変わるので、変更として出す。"""
    out = []
    yn = lambda v: "ループ" if v else "ふつうのキュー"
    if bool(n.get("loop")) != bool(r.get("loop")):
        out.append(("ループ", yn(n.get("loop")), yn(r.get("loop"))))
    elif n.get("loopEndMs") != r.get("loopEndMs") and r.get("loop"):
        out.append(("ループ終", ms_to_str(n.get("loopEndMs") or 0), ms_to_str(r.get("loopEndMs") or 0)))
    return out


def cue_title(short_name: str, letter: str | None, name: str) -> str:
    return f"{short_name} / {letter}「{name}」" if name else f"{short_name} / {letter}（無名）"


_RB_TRACKS: dict[str, dict] = {}  # rekordbox の曲ID -> 曲情報（🎵Tracks に無い曲を作るのに使う）


def load_rekordbox() -> dict[str, dict]:
    """UUID -> キューの現状（rekordbox が唯一の正）。"""
    tracks = rb_export.export(na.config.rekordbox_options()["folderFilter"])["tracks"]
    names = build_short_names(tracks)
    _RB_TRACKS.clear()
    out = {}
    for t in tracks:
        _RB_TRACKS[t["id"]] = {**t, "shortName": names[t["id"]]}
        for c in t["cues"]:
            if c["kind"] != "hot":
                continue
            out[c["uuid"]] = {
                "trackId": t["id"],
                "trackTitle": t["title"],
                "title": cue_title(names[t["id"]], c["letter"], c["name"]),
                "letter": c["letter"],
                "name": c["name"],
                "positionMs": c["positionMs"],
                # ループかどうか（実機で終わりの位置が入っているか）。押し方が変わるので鏡に載せる
                "loop": bool(c.get("loop")),
                "loopEndMs": c.get("loopEndMs"),
                "priority": t["priority"],
            }
    return out


def load_notion() -> dict[str, dict]:
    """UUID -> Notion 上の現在値。"""
    out = {}
    for page in na.query_all(CUES):
        p = page["properties"]
        uuid = na.plain(p.get("cueUUID"))
        if not uuid:
            continue  # UUID の無い行は機械管理外。触らない
        rel = (p.get("曲") or {}).get("relation") or []
        out[uuid] = {
            "pageId": page["id"],
            "title": na.plain(p.get("キュー")),
            "letter": na.select_name(p.get("記号")),
            "name": na.plain(p.get("キュー名")),
            "positionMs": (p.get("位置ms") or {}).get("number"),
            # 列がまだ無いワークスペースでも動く（無ければ「ループではない」）
            "loop": bool((p.get("ループ") or {}).get("checkbox")),
            "loopEndMs": (p.get("ループ終ms") or {}).get("number"),
            # UUID が変わったときに「同じ曲の同じ位置」を探すために要る
            "trackPageId": rel[0]["id"] if rel else None,
        }
    return out


def build_plan(rb: dict, nt: dict) -> list[dict]:
    """変更を4種類に分類する。並び順 = 重要度順。"""
    plan = []

    for uuid, r in rb.items():
        n = nt.get(uuid)
        if n is None:
            plan.append({"kind": "add", "uuid": uuid, "rb": r,
                         "summary": f"新しいキュー: {r['title']}"})
            continue

        changes = []
        if n["letter"] != r["letter"]:
            changes.append(("記号", n["letter"], r["letter"]))
        if nfc(n["name"]) != nfc(r["name"]):
            changes.append(("キュー名", n["name"] or "(無名)", r["name"] or "(無名)"))
        if n["positionMs"] != r["positionMs"]:
            changes.append(("位置", ms_to_str(n["positionMs"] or 0), ms_to_str(r["positionMs"])))
        changes += loop_changes(n, r)
        if nfc(n["title"]) != nfc(r["title"]):
            changes.append(("表示名", n["title"], r["title"]))

        if not changes:
            continue
        # 位置だけの変更は押す場所が変わらないので通知のみ（ループの終わりも同じ扱い）
        only_position = {c[0] for c in changes} <= {"位置", "ループ終"}
        plan.append({
            "kind": "notice" if only_position else "update",
            "uuid": uuid, "rb": r, "notion": n, "changes": changes,
            "summary": r["title"],
        })

    for uuid, n in nt.items():
        if uuid not in rb:
            plan.append({"kind": "delete", "uuid": uuid, "notion": n,
                         "summary": f"rekordbox から消えたキュー: {n['title']}"})

    rekey(plan)

    # 新しい曲のキューを足すには、先に 🎵Tracks の行が要る。曲ごとに1件の「曲追加」を前に置く
    pages = _track_pages()
    seen_tracks: set[str] = set()
    for a in [p for p in plan if p["kind"] == "add"]:
        tid = a["rb"]["trackId"]
        if tid in pages or tid in seen_tracks:
            continue
        seen_tracks.add(tid)
        t = _RB_TRACKS[tid]
        plan.append({"kind": "track_add", "uuid": tid, "track": t,
                     "summary": f"新しい曲: {_track_title(t)}"})

    # 既存の曲行が実機とズレていたら直す。
    # **これが無いと、実機で曲名やアーティストを整えても Notion に一生届かない**
    # （`track_add` は新規作成しかしないため。実測 2026-09-09: 71件中57件が古いまま残っていた）。
    # 🎵Tracks は rekordbox の鏡なので、実機の値で上書きしてよい。
    for rbid, page_id in pages.items():
        t = _RB_TRACKS.get(rbid)
        if not t:
            continue  # 実機から消えた曲は下の track_delete が扱う
        now, want = _TRACK_NOW.get(rbid, {}), track_values(t)
        changes = [(k, fmt_value(now.get(k)), fmt_value(want[k]))
                   for k in want if not same_value(now.get(k), want[k])]
        if changes:
            plan.append({"kind": "track_update", "pageId": page_id, "track": t,
                         "changes": changes, "summary": _track_title(t)})

    # rekordbox から消えた曲。キューと違って曲行はこれまで消していなかったので、
    # リネーム等で置き換わった古い行が 🎵Tracks に残り続ける
    # （アプリの曲一覧に「0キュー」の重複として出る。実測: イワンポルカ旧行）。
    # 消してよいのは、キュー行が1件も残っておらず 🔀Transitions からの参照も無いときだけ。
    stale = {page_id: rbid for rbid, page_id in pages.items() if rbid not in _RB_TRACKS}
    if stale:
        live_cues = {n["trackPageId"] for n in nt.values()}
        refs = _transition_track_refs()
        for page_id, rbid in stale.items():
            title = _TRACK_TITLES.get(page_id) or rbid
            if page_id in live_cues:
                plan.append({"kind": "track_hold", "pageId": page_id,
                             "summary": f"rekordbox から消えた曲: {title}（キュー行が残っているため保留）"})
            elif page_id in refs:
                plan.append({"kind": "track_hold", "pageId": page_id,
                             "summary": f"rekordbox から消えた曲: {title}（🔀Transitions から参照あり。人が確認）"})
            else:
                plan.append({"kind": "track_delete", "pageId": page_id, "uuid": rbid,
                             "summary": f"rekordbox から消えた曲: {title}"})

    order = {"rekey": 0, "update": 1, "delete": 2, "track_delete": 3, "track_hold": 4,
             "track_add": 5, "add": 6, "track_update": 7, "notice": 8}
    plan.sort(key=lambda x: (order[x["kind"]], x["summary"]))
    return plan


def rekey(plan: list[dict]) -> None:
    """「削除 + 追加」に見えているものを、位置を手掛かりに同じキューとして結び直す。

    キューを作り直すと UUID が変わる（メモリーキュー→ホットキュー変換が典型）。
    そのまま削除+追加として処理すると Notion のキュー行が作り直され、
    **その行を参照している 🔀Transitions のリンクが切れる**。
    位置は変換で動かないので、それを頼りに既存の行の UUID を差し替える。

    決め打ちはしない。曲の中で位置が重複することがあるので、
    候補が一意に決まるときだけ結ぶ（残りは追加/削除のまま人に見せる）。
    """
    adds = [p for p in plan if p["kind"] == "add"]
    dels = [p for p in plan if p["kind"] == "delete"]
    if not adds or not dels:
        return

    # Notion の曲ページID -> rekordbox の曲ID（削除側と追加側を同じ土俵に乗せる）
    page_to_track = {v: k for k, v in _track_pages().items()}

    def track_of_delete(item: dict) -> str | None:
        page = item["notion"].get("trackPageId")
        return page_to_track.get(page) if page else None

    matched: list[tuple[dict, dict, str]] = []
    used_del: set[int] = set()
    used_add: set[int] = set()

    def try_match(same, why: str) -> None:
        """削除側と追加側が同じ曲で same() を満たし、両側から見て相手が1つだけのときに結ぶ。"""
        for ai, a in enumerate(adds):
            if ai in used_add:
                continue
            r = a["rb"]
            cands = [di for di, d in enumerate(dels)
                     if di not in used_del and track_of_delete(d) == r["trackId"]
                     and same(d["notion"], r)]
            if len(cands) != 1:
                continue  # 候補が複数 = 推測になる。触らない
            d = dels[cands[0]]
            others = [aj for aj, b in enumerate(adds)
                      if aj != ai and aj not in used_add
                      and b["rb"]["trackId"] == r["trackId"] and same(d["notion"], b["rb"])]
            if others:
                continue
            used_del.add(cands[0]); used_add.add(ai)
            matched.append((d, a, why))

    def same_pos(n, r): return n["positionMs"] == r["positionMs"]
    def same_name(n, r): return nfc(n["name"]) == nfc(r["name"])
    def prefix_name(n, r):
        x, y = nfc(n["name"]), nfc(r["name"])
        return bool(x and y) and (x.startswith(y) or y.startswith(x))

    try_match(lambda n, r: same_pos(n, r) and same_name(n, r), "位置とキュー名が一致")
    # 同位置・同名が複数あるとき（`D/F/G「1サビ終」` のように打ち直したもの）だけ、記号で選ぶ
    try_match(lambda n, r: same_pos(n, r) and same_name(n, r) and n["letter"] == r["letter"],
              "位置とキュー名が一致（同名が複数。記号で選択）")
    # 同位置・同名の行が複数消えて記号でも選べないとき（重複キューを1つに整理して打ち直した形）は、
    # 🔀Transitions から参照されている行を生かして結ぶ。参照を切らないことが rekey の目的なので、
    # 参照の無い方を削除に回すのは推測ではない（実例: ヤラララ E/F「1サビ終ル」が同位置 → D に打ち直し）
    cue_refs = _transition_cue_refs()
    try_match(lambda n, r: same_pos(n, r) and same_name(n, r) and n["pageId"] in cue_refs,
              "位置とキュー名が一致（同位置同名が複数。繋ぎから参照されている行を選択）")
    try_match(same_pos, "位置が一致")
    # 「1サビ終受け」→「1サビ終」のように名前を削った/足した場合。位置が同じなら前方一致で結ぶ
    try_match(lambda n, r: same_pos(n, r) and prefix_name(n, r), "位置が一致し、キュー名が前方一致")
    try_match(same_name, "キュー名が一致（位置は動いている）")

    for d, a, why in matched:
        plan.remove(d)
        plan.remove(a)
        r, n = a["rb"], d["notion"]
        changes = [("UUID", d["uuid"][:8] + "…", a["uuid"][:8] + "…")]
        if n["letter"] != r["letter"]:
            changes.append(("記号", n["letter"], r["letter"]))
        if nfc(n["name"]) != nfc(r["name"]):
            changes.append(("キュー名", n["name"] or "(無名)", r["name"] or "(無名)"))
        if n["positionMs"] != r["positionMs"]:
            changes.append(("位置", ms_to_str(n["positionMs"] or 0), ms_to_str(r["positionMs"])))
        changes += loop_changes(n, r)
        plan.append({
            "kind": "rekey", "uuid": a["uuid"], "rb": r, "notion": n,
            "changes": changes, "why": why, "summary": r["title"],
        })


LABEL = {"rekey": "作り直し", "update": "変更", "delete": "削除", "track_delete": "曲削除",
         "track_hold": "曲削除(保留)", "track_add": "曲追加", "add": "追加",
         "track_update": "曲更新", "notice": "位置のみ"}


def show(item: dict, i: int, total: int) -> None:
    print(f"\n[{i}/{total}] {LABEL[item['kind']]}  {item['summary']}")
    if item["kind"] == "rekey":
        print(f"        ※ 作り直されたキュー（{item['why']}）。"
              f"行はそのままに UUID を差し替えます = トランジションの参照が切れません")
    for field, before, after in item.get("changes", []):
        mark = " ★" if field == "記号" else ""
        print(f"        {field}:  {before}  →  {after}{mark}")
    if item["kind"] == "delete":
        print("        ※ このキューを参照しているトランジションがあれば、そちらも要確認になります")
    if item["kind"] == "track_delete":
        print("        ※ 🎵Tracks の行をアーカイブします（キュー0件・🔀Transitions 参照0件を確認済み）")
    if item["kind"] == "track_hold":
        print("        ※ 自動では消しません。解消されるまで次回の sync でも出ます")
    if item["kind"] == "track_update":
        print("        ※ 🎵Tracks は rekordbox の鏡。実機で整えた曲名・アーティスト・"
              "ジャンルをそのまま写します（キューと繋ぎには触りません）")


def _track_title(t: dict) -> str:
    """🎵Tracks の曲名列。既存行に合わせて「短縮名 / 原題」（短縮名が原題そのものなら原題だけ）。"""
    short, title = t["shortName"], t["title"]
    return title if short == title else f"{short} / {title}"


def same_value(a, b) -> bool:
    """曲行の1項目が同じか。**数は数として比べる** —
    Notion は `160`、rekordbox は `160.0` を返すので、文字列で比べると
    71曲すべてに「BPM が変わった」という嘘の差分が出る。
    """
    if a is None and b is None:
        return True
    if isinstance(a, (int, float)) or isinstance(b, (int, float)):
        if a is None or b is None:
            return False
        try:
            return abs(float(a) - float(b)) < 1e-6
        except (TypeError, ValueError):
            return False
    return nfc(str(a or "")) == nfc(str(b or ""))


def fmt_value(v) -> str:
    """差分表示用。空は「(空)」、整数で表せる数は小数点を出さない。"""
    if v is None or v == "":
        return "(空)"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def track_values(t: dict) -> dict:
    """rekordbox が正とする曲行の中身。追加と更新で同じ組み立てを使う。"""
    return {
        "曲名": _track_title(t),
        "別名": t["shortName"],
        "アーティスト": t.get("artist") or "",
        "ジャンル": t.get("genre") or "",
        "BPM": t.get("bpm") or None,
        "Key": t.get("key") or "",
        "長さ秒": t.get("durationSec") or None,
        "ファイルパス": t.get("filePath") or "",
    }


def track_props(t: dict) -> dict:
    """`track_values` を Notion のプロパティ形に変える。"""
    v = track_values(t)
    text_keys = ("曲名", "別名", "アーティスト", "ジャンル", "Key", "ファイルパス")
    out = {k: (na.title_prop(v[k]) if k == "曲名" else na.text_prop(v[k])) for k in text_keys}
    out["rekordboxID"] = na.text_prop(t["id"])
    out["BPM"] = {"number": v["BPM"]}
    out["長さ秒"] = {"number": v["長さ秒"]}
    return out


def apply(item: dict) -> None:
    if item["kind"] == "track_add":
        t = item["track"]
        page = na.request("POST", "/pages", {
            "parent": {"database_id": na.CONFIG["tracks"]},
            "properties": track_props(t),
        })
        _track_pages()[t["id"]] = page["id"]  # 直後の「追加」がこの曲を参照できるように
    elif item["kind"] == "track_update":
        na.request("PATCH", f"/pages/{item['pageId']}", {"properties": track_props(item["track"])})
    elif item["kind"] == "add":
        r = item["rb"]
        na.request("POST", "/pages", {
            "parent": {"database_id": CUES},
            "properties": {
                "キュー": na.title_prop(r["title"]),
                "記号": {"select": {"name": r["letter"]}},
                "キュー名": na.text_prop(r["name"]),
                "位置": na.text_prop(ms_to_str(r["positionMs"])),
                "位置ms": {"number": r["positionMs"]},
                "種別": {"select": {"name": "Hot"}},
                **loop_props(r),
                "cueUUID": na.text_prop(item["uuid"]),
                "曲": {"relation": [{"id": _track_page(r["trackId"])}]},
            },
        })
    elif item["kind"] in ("update", "rekey"):
        r = item["rb"]
        props = {
            "キュー": na.title_prop(r["title"]),
            "記号": {"select": {"name": r["letter"]}},
            "キュー名": na.text_prop(r["name"]),
            "位置": na.text_prop(ms_to_str(r["positionMs"])),
            "位置ms": {"number": r["positionMs"]},
            **loop_props(r),
        }
        if item["kind"] == "rekey":
            # 行は残したまま、指す先だけを新しいキューに付け替える
            props["cueUUID"] = na.text_prop(item["uuid"])
        na.request("PATCH", f"/pages/{item['notion']['pageId']}", {"properties": props})
    elif item["kind"] == "delete":
        na.request("PATCH", f"/pages/{item['notion']['pageId']}", {"archived": True})
    elif item["kind"] == "track_delete":
        na.request("PATCH", f"/pages/{item['pageId']}", {"archived": True})


_TRACK_PAGES: dict[str, str] | None = None
_TRACK_TITLES: dict[str, str] = {}  # Notion の曲ページID -> 曲名（消えた曲を人に見せるときに使う）
_TRACK_NOW: dict[str, dict] = {}    # rekordbox の曲ID -> Notion 上の現在値（更新の差分用）


def _track_pages() -> dict[str, str]:
    """rekordbox の曲ID -> Notion の曲ページID（1回だけ取得して使い回す）。"""
    global _TRACK_PAGES
    if _TRACK_PAGES is None:
        _TRACK_PAGES = {}
        for page in na.query_all(na.CONFIG["tracks"]):
            p = page["properties"]
            rid = na.plain(p.get("rekordboxID"))
            if rid:
                _TRACK_PAGES[rid] = page["id"]
                _TRACK_TITLES[page["id"]] = na.plain(p.get("曲名"))
                _TRACK_NOW[rid] = {
                    "曲名": na.plain(p.get("曲名")),
                    "別名": na.plain(p.get("別名")),
                    "アーティスト": na.plain(p.get("アーティスト")),
                    # 列がまだ無いワークスペースでも動く（無ければ空。書く直前に生える）
                    "ジャンル": na.plain(p.get("ジャンル")),
                    "BPM": (p.get("BPM") or {}).get("number"),
                    "Key": na.plain(p.get("Key")),
                    "長さ秒": (p.get("長さ秒") or {}).get("number"),
                    "ファイルパス": na.plain(p.get("ファイルパス")),
                }
    return _TRACK_PAGES


def _transition_refs(keys: tuple[str, str]) -> set[str]:
    refs: set[str] = set()
    for page in na.query_all(na.CONFIG["transitions"]):
        p = page["properties"]
        for key in keys:
            refs.update(r["id"] for r in ((p.get(key) or {}).get("relation") or []))
    return refs


def _transition_track_refs() -> set[str]:
    """🔀Transitions が From曲/To曲 で参照している曲ページID。曲行を消す前の安全確認。"""
    return _transition_refs(("From曲", "To曲"))


def _transition_cue_refs() -> set[str]:
    """🔀Transitions が Fromキュー/Toキュー で参照しているキューページID。rekey の最終タイブレーク。"""
    return _transition_refs(("Fromキュー", "Toキュー"))


def _track_page(rekordbox_id: str) -> str:
    """rekordbox の曲ID -> Notion の曲ページID。"""
    if rekordbox_id not in _track_pages():
        raise na.NotionError(f"🎵Tracks に未登録の曲です（rekordboxID={rekordbox_id}）")
    return _track_pages()[rekordbox_id]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="差分を出すだけ。何も書き込まない")
    ap.add_argument("--yes", action="store_true", help="全件承認する（内容を確認済みのときだけ）")
    args = ap.parse_args()

    print("rekordbox を読み込み中…（master.db はコピーしてから読みます）")
    rb = load_rekordbox()
    print(f"  ホットキュー {len(rb)} 件")

    print("Notion 📍Cues を読み込み中…")
    nt = load_notion()
    print(f"  {len(nt)} 件")

    plan = build_plan(rb, nt)
    actionable = [p for p in plan if p["kind"] != "notice"]

    if not plan:
        print("\n差分はありません。Notion と rekordbox は一致しています。")
        return 0

    counts = {k: sum(1 for p in plan if p["kind"] == k) for k in LABEL}
    print("\n" + " / ".join(f"{LABEL[k]} {v}件" for k, v in counts.items() if v))

    for i, item in enumerate(plan, 1):
        show(item, i, len(plan))

    if args.dry_run:
        print("\n--dry-run のため何も書き込みませんでした。")
        return 0
    if not actionable:
        print("\n書き込みが必要な変更はありません（位置の移動のみ）。")
        return 0

    print("\n" + "=" * 60)
    approved = []
    for i, item in enumerate(actionable, 1):
        if args.yes:
            approved.append(item)
            continue
        show(item, i, len(actionable))
        ans = input("        反映しますか？ [y]es / [n]o / [a]ll / [q]uit > ").strip().lower()
        if ans == "q":
            break
        if ans == "a":
            approved.extend(actionable[i - 1:])
            break
        if ans in ("y", "yes"):
            approved.append(item)

    if not approved:
        print("\n何も反映しませんでした。")
        return 0

    ensure_loop_columns()   # ループ列が無いワークスペースでは、ここで1度だけ生える
    ensure_track_columns()  # 同じくジャンル列
    print(f"\n{len(approved)} 件を Notion に反映します…")
    for item in approved:
        apply(item)
        print(f"  ✓ {LABEL[item['kind']]}  {item['summary']}")

    skipped = len(actionable) - len(approved)
    if skipped:
        print(f"\n{skipped} 件は保留のままです。次回の sync でまた出ます。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
