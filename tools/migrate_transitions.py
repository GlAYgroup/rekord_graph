#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""手書きの「完全版」ページを 🔀Transitions DB に移行する。

※ 作者の手書きメモ（Notion の特定ページ）専用の一回きりの移行ツール。
   配布物としては参考実装。自分のメモを流し込むなら SOURCE_PAGE と解析の正規表現を差し替える。

    ./.venv/bin/python tools/migrate_transitions.py            # 解析して報告するだけ
    ./.venv/bin/python tools/migrate_transitions.py --apply    # 解決できた分を投入

★ 照合の原則（CLAUDE.md 参照）:
   キュー名（「」の中身）が一次キー。アルファベットは補助でしかない。
   記号が食い違ったら「実機が正」として直し、その旨を必ず報告する。
★ 解決できなかったものは勝手に作らない。必ず一覧で出して人に判断してもらう。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import notion_api as na

# 移行元の手書きメモのページ ID。作者固有なので環境変数で渡す
SOURCE_PAGE = os.environ.get("MIGRATE_SOURCE_PAGE") or ""
ROOT = Path(__file__).resolve().parent.parent

# 「曲A → 曲B」。全角/半角の矢印ゆれと、頭の「分岐：」を吸収する
EDGE = re.compile(r"^(?:分岐[:：]\s*)?(.+?)\s*(?:→|->|⇒)\s*(.+?)\s*$")
# 「曲名：F「キュー名」ループ」/「曲名：B 1小説前」の両方を拾う
CUE = re.compile(r"^(?P<track>[^:：]+)[:：]\s*(?P<rest>.+)$")
CUE_NAME = re.compile(r"「(?P<name>[^」]*)」")
LETTER = re.compile(r"(?<![A-Za-z])([A-P])(?![A-Za-z])")
BARS = re.compile(r"(\d+)\s*(?:小節|小説)")  # 「小説」はメモ内の誤変換


def nfc(s: str | None) -> str:
    return unicodedata.normalize("NFC", (s or "")).strip()


def key(s: str | None) -> str:
    """照合用キー。空白・記号・大文字小文字の差を潰す。"""
    s = unicodedata.normalize("NFKC", (s or "")).lower()
    return re.sub(r"[\s　・！!?？\-_/.、。]+", "", s)


# ---------------------------------------------------------------- 取得と解析

def fetch_blocks(block_id: str, depth: int = 0) -> list[dict]:
    out, cursor = [], None
    while True:
        q = f"/blocks/{block_id}/children?page_size=100" + (f"&start_cursor={cursor}" if cursor else "")
        r = na.request("GET", q)
        for b in r["results"]:
            t = b["type"]
            out.append({
                "depth": depth,
                "type": t,
                "text": nfc("".join(x.get("plain_text", "") for x in b.get(t, {}).get("rich_text", []))),
            })
            if b.get("has_children"):
                out.extend(fetch_blocks(b["id"], depth + 1))
        if not r.get("has_more"):
            return out
        cursor = r["next_cursor"]


def parse_cue_ref(text: str) -> dict | None:
    m = CUE.match(text)
    if not m:
        return None
    rest = m.group("rest")
    name_m = CUE_NAME.search(rest)
    # 「」の外側だけから記号を拾う（キュー名に A〜P が含まれても誤検出しないため）
    outside = CUE_NAME.sub(" ", rest)
    letter_m = LETTER.search(outside)
    bars_m = BARS.search(rest)
    return {
        "raw": text,
        "track": nfc(m.group("track")),
        "cueName": nfc(name_m.group("name")) if name_m else "",
        "letterInNote": letter_m.group(1) if letter_m else None,
        "loop": "ループ" in rest,
        "bars": int(bars_m.group(1)) if bars_m else None,
        "tail": nfc(outside),
    }


def parse(blocks: list[dict]) -> list[dict]:
    """ブロック列 -> エッジ列。空段落をチェーンの区切りとみなす。"""
    edges, cur, chain = [], None, 1
    for b in blocks:
        text, typ, depth = b["text"], b["type"], b["depth"]

        if typ == "paragraph" and not text:
            if cur:  # 空行が来たらチェーンを切る
                chain += 1
            continue
        if not text:
            continue

        if typ == "numbered_list_item":
            m = EDGE.match(text)
            if m:
                cur = {"from": nfc(m.group(1)), "to": nfc(m.group(2)), "refs": [], "notes": [],
                       "chain": f"chain{chain}", "isBranch": text.startswith("分岐"), "raw": text}
                edges.append(cur)
                continue

        if cur is None:
            continue
        if text.startswith("→"):
            cur["notes"].append(nfc(text.lstrip("→ ")))
        elif ref := parse_cue_ref(text):
            cur["refs"].append(ref)
    return edges


# ---------------------------------------------------------------- 解決

def load_index() -> tuple[dict, dict]:
    """Notion の Tracks / Cues を照合用に読み込む。"""
    tracks = {}
    for p in na.query_all(na.CONFIG["tracks"]):
        pr = p["properties"]
        tracks[p["id"]] = {
            "pageId": p["id"],
            "title": nfc(na.plain(pr.get("曲名"))),
            "alias": nfc(na.plain(pr.get("別名"))),
            "rekordboxId": na.plain(pr.get("rekordboxID")),
        }
    cues = {}
    for p in na.query_all(na.CONFIG["cues"]):
        pr = p["properties"]
        rel = pr.get("曲", {}).get("relation") or []
        cues[p["id"]] = {
            "pageId": p["id"],
            "title": nfc(na.plain(pr.get("キュー"))),
            "name": nfc(na.plain(pr.get("キュー名"))),
            "letter": na.select_name(pr.get("記号")),
            "trackPageId": rel[0]["id"] if rel else None,
        }
    return tracks, cues


def resolve_track(note_name: str, tracks: dict, aliases: dict) -> list[dict]:
    """メモ中の曲名 -> Notion の曲候補。曖昧なら複数返す（勝手に決めない）。"""
    k = key(aliases.get(note_name, note_name))
    hits = [t for t in tracks.values() if k and (k == key(t["alias"]) or k in key(t["title"]))]
    return hits or [t for t in tracks.values() if k and key(t["title"]) in k]


def resolve_cue(ref: dict, candidates: list[dict], cues: dict) -> tuple[dict | None, str]:
    """キュー名を一次キーにキューを解決する。戻り値 = (キュー, 判定理由)。

    曲名の候補が複数あっても、キュー名が一意に決まれば曲も確定できる。
    例: メモの「メルト」は2曲に当たるが、「助走 受け」を持つのは Nurecha 版だけ。
    記号は同名キューが複数あるときのタイブレークにしか使わない（記号は信用できない）。
    """
    pool = [c for c in cues.values() if c["trackPageId"] in {t["pageId"] for t in candidates}]
    n = key(ref["cueName"])

    def narrow(matches: list[dict], why: str) -> tuple[dict | None, str]:
        if not matches:
            return None, ""
        if len(matches) > 1 and ref["letterInNote"]:
            exact = [m for m in matches if m["letter"] == ref["letterInNote"]]
            if len(exact) == 1:
                return exact[0], why + "+記号"
        if len(matches) == 1:
            return matches[0], why
        return matches[0], why + "（複数候補）"

    if n:
        tiers = (
            ("完全一致", lambda c: key(c["name"]) == n),
            ("前方一致", lambda c: key(c["name"]) and (key(c["name"]).startswith(n) or n.startswith(key(c["name"])))),
            ("部分一致", lambda c: key(c["name"]) and (n in key(c["name"]) or key(c["name"]) in n)),
        )
        for why, test in tiers:
            hit, w = narrow([c for c in pool if test(c)], why)
            if hit:
                return hit, w
    # キュー名を書いていない記法（例: 「ダイダイ…：A 1.1bars」）は記号で拾うしかない
    if ref["letterInNote"]:
        hit, w = narrow([c for c in pool if c["letter"] == ref["letterInNote"]], "記号のみ")
        if hit:
            return hit, w
    return None, ""


def main() -> int:
    if not SOURCE_PAGE:
        print("環境変数 MIGRATE_SOURCE_PAGE に移行元ページの ID を入れてください", file=sys.stderr)
        return 2
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="解決できたものを Transitions に投入する")
    args = ap.parse_args()

    aliases = {v: k for k, v in {}.items()}  # 予約: メモ側の別表記 -> 正式名
    seed = json.loads((ROOT / "data/aliases.json").read_text(encoding="utf-8"))
    aliases = {v: v for k, v in seed.items() if not k.startswith("_")}
    aliases.update({  # メモ内の誤字・略記
        "ドーナルホール": "ドーナツホール", "Rabit Hole": "Rabbit Hole",
        "ダイダイダイダイキライ": "ダイダイダイダイダイキライ", "脳漿": "脳漿炸裂ガール",
        "バットアップル": "BAD APPLE!!", "マーシャル": "マーシャル・マキシマイザー",
    })

    print("完全版ページを取得中…")
    edges = parse(fetch_blocks(SOURCE_PAGE))
    print(f"  エッジ {len(edges)} 件")

    print("Notion の Tracks / Cues を読み込み中…")
    tracks, cues = load_index()

    # 人が判断した対応付け。自動解決より優先する（再実行しても同じ結果になるように）
    ov_raw = json.loads((ROOT / "data/migration_overrides.json").read_text(encoding="utf-8"))
    overrides = {k: v for k, v in ov_raw.items() if not k.startswith("_")}
    by_title = {nfc(c["title"]): c for c in cues.values()}
    for k, v in overrides.items():
        for side in ("from", "to"):
            if v.get(side) and nfc(v[side]) not in by_title:
                print(f"  ⚠ overrides のキューが見つかりません: {k} / {side} -> {v[side]}")

    resolved, problems = [], []
    for e in edges:
        row = {"edge": e, "ends": []}
        for side, note_name in (("from", e["from"]), ("to", e["to"])):
            ref = next((r for r in e["refs"] if key(aliases.get(r["track"], r["track"])) == key(aliases.get(note_name, note_name))), None)
            cands = resolve_track(note_name, tracks, aliases)
            cue, why = (resolve_cue(ref, cands, cues) if (ref and cands) else (None, ""))
            ov = overrides.get(f"{e['from']} → {e['to']}", {})
            if ov.get(side):
                cue, why = by_title.get(nfc(ov[side]), cue), "手動確定"
            row["ends"].append({"side": side, "noteName": note_name, "ref": ref,
                                "tracks": cands, "cue": cue, "why": why})
        # 自動確定は「キュー名が完全/前方一致」かつ「曲が一意」のときだけ。
        # 部分一致や記号だけの一致は、実際に誤マッチを生んだので必ず人に確認する。
        ok = all(
            x["cue"] and x["why"].startswith(("完全一致", "前方一致", "手動確定")) and "複数候補" not in x["why"]
            for x in row["ends"]
        )
        (resolved if ok else problems).append(row)

    print(f"\n解決 {len(resolved)} 件 / 要確認 {len(problems)} 件\n" + "=" * 64)

    mismatches = []
    for r in resolved:
        e = r["edge"]
        head = f"{e['from']} → {e['to']}" + ("  (分岐)" if e["isBranch"] else "")
        print(f"\n✓ {head}   [{e['chain']}]")
        for x in r["ends"]:
            c, ref = x["cue"], x["ref"]
            mark = ""
            if ref["letterInNote"] and ref["letterInNote"] != c["letter"]:
                mark = f"   ★記号ズレ: メモ {ref['letterInNote']} → 実機 {c['letter']}"
                mismatches.append((head, ref["raw"], ref["letterInNote"], c["letter"]))
            print(f"    {x['side']:4s} {c['title']}   ({x['why']}){mark}")
        if e["notes"]:
            print(f"    💬 {' / '.join(e['notes'])}")

    if problems:
        print("\n" + "=" * 64 + "\n要確認（自動では解決できませんでした）\n")
        for r in problems:
            e = r["edge"]
            print(f"✗ {e['from']} → {e['to']}")
            for x in r["ends"]:
                if x["cue"] and x["why"].startswith(("完全一致", "前方一致", "手動確定")) and "複数候補" not in x["why"]:
                    continue
                if not x["ref"]:
                    print(f"    {x['side']:4s} 「{x['noteName']}」のキュー行が見つかりません")
                elif not x["tracks"]:
                    print(f"    {x['side']:4s} 曲が未解決: 「{x['noteName']}」")
                elif "複数候補" in (x["why"] or ""):
                    cand = " / ".join(t["title"][:40] for t in x["tracks"][:4])
                    print(f"    {x['side']:4s} 候補が複数: {x['ref']['raw']}")
                    print(f"         → {cand}")
                elif not x["cue"]:
                    print(f"    {x['side']:4s} キュー名が一致せず: {x['ref']['raw']}")
                    pool = [c['title'] for c in cues.values() if c['trackPageId'] == x['tracks'][0]['pageId']]
                    print(f"         その曲のキュー: {' / '.join(sorted(pool))[:150]}")
                else:
                    print(f"    {x['side']:4s} 確信が低い一致（{x['why']}）: {x['ref']['raw']}")
                    print(f"         → {x['cue']['title']}")

    if mismatches:
        print("\n" + "=" * 64 + f"\n★ 記号ズレ {len(mismatches)} 件（実機の値で登録します）\n")
        for head, raw, a, b in mismatches:
            print(f"  {head:38s} {raw}  →  実機 {b}")

    if not args.apply:
        print("\n--apply を付けると、解決できた分を Transitions に投入します。")
        return 0

    print(f"\n{len(resolved)} 件を 🔀Transitions に投入します…")
    for i, r in enumerate(resolved, 1):
        e = r["edge"]
        f, t = r["ends"]
        na.request("POST", "/pages", {
            "parent": {"database_id": na.CONFIG["transitions"]},
            "properties": {
                "つなぎ": na.title_prop(f"{e['from']} → {e['to']}"),
                "From曲": {"relation": [{"id": f["cue"]["trackPageId"]}]},
                "Fromキュー": {"relation": [{"id": f["cue"]["pageId"]}]},
                "To曲": {"relation": [{"id": t["cue"]["trackPageId"]}]},
                "Toキュー": {"relation": [{"id": t["cue"]["pageId"]}]},
                "コメント": na.text_prop(" / ".join(e["notes"])),
                **({"小節数": {"number": bars}} if (bars := next((r["bars"] for r in e["refs"] if r["bars"]), None) or overrides.get(f"{e['from']} → {e['to']}", {}).get("bars")) else {}),
                "チェーン": na.text_prop(e["chain"]),
                "順番": {"number": i},
                "同期ステータス": {"select": {"name": "OK"}},
                "出典": na.text_prop("完全版" + ("（分岐）" if e["isBranch"] else "")),
            },
        })
        print(f"  ✓ {e['from']} → {e['to']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
