#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""data/rekordbox.json -> Notion 📍Cues への投入ペイロード（バッチ分割）。

キューのタイトルは「短縮名 / 記号「キュー名」」。
Notion のリレーション選択はタイトルの部分一致で絞れるので、
Transitions で曲名を打てばその曲のキューだけが並ぶ。
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _json(path: Path, default):
    """個人データは無いことがある（配布直後など）。無ければ既定値で動く。"""
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


# 曲名の別名（rekordbox タイトルに含まれる文字列 -> 短い呼び名）。無ければ原題を刈り込むだけ
ALIASES = {k: v for k, v in _json(ROOT / "data/aliases.json", {}).items() if not k.startswith("_")}
IDS = _json(ROOT / "data/notion_track_ids.json", {})
# 投入済みの cueUUID。二重投入を防ぐ（UUID は不変なので、これが唯一の確実な判定材料）
LOADED = set(_json(ROOT / "data/loaded_cue_uuids.json", []))


def base_name(title: str) -> str:
    """キュー名の頭に付ける短い曲名。別名があればそれ、無ければタイトルを刈り込む。

    括弧は**全角も切る**。実機のタイトルは `ベノム（Gakui bootleg）` の形なので、
    半角だけ見ているとリミックス名まで短縮名に入る（アプリの `songName` は
    全角も割っているので、揃えないと Notion とアプリで別の名前になる）。
    """
    for key, alias in ALIASES.items():
        if key.lower() in title.lower():
            return alias
    import re
    return re.split(r"[(\[（［]", title)[0].strip()[:24] or title[:24]


def remix_tag(title: str) -> str:
    """同じ短縮名の曲が複数あるときに付ける識別子。リミックス名を拾う。"""
    import re
    for m in re.findall(r"[(（\[]([^)）\]]+)[)）\]]", title):
        m = m.strip()
        if not m or m[0].isdigit() or re.match(r"(?i)^(ft\.|feat\.)", m):
            continue  # 「ft. 重音テト」等は曲の区別にならない
        return re.split(r"\s+", m)[0][:12]
    return title.split("_")[-1][:12] or title[:12]


def build_short_names(tracks: list) -> dict:
    """曲ID -> 一意な短縮名。衝突したものだけリミックス名を付ける。

    ここが曖昧だと、入力時に別の曲のキューを選んでしまう。必ず一意にする。
    """
    groups: dict[str, list] = {}
    for t in tracks:
        groups.setdefault(base_name(t["title"]), []).append(t)
    out = {}
    for base, ts in groups.items():
        for t in ts:
            out[t["id"]] = base if len(ts) == 1 else f"{base}({remix_tag(t['title'])})"
    return out


def ms_to_str(ms: int) -> str:
    s, msec = divmod(int(ms or 0), 1000)
    m, s = divmod(s, 60)
    return f"{m}:{s:02d}.{msec:03d}"


def main() -> int:
    start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 78

    tracks = json.loads((ROOT / "data/rekordbox.json").read_text(encoding="utf-8"))["tracks"]
    names = build_short_names(tracks)

    rows = []
    for t in tracks:
        page = IDS.get(t["id"])
        if not page:
            print(f"# 未投入の曲をスキップ: {t['title']}", file=sys.stderr)
            continue
        sn = names[t["id"]]
        for c in t["cues"]:
            if c["kind"] != "hot":
                continue  # メモリーキューは全てホットキューと同位置なので重複させない
            if c["uuid"] in LOADED:
                continue
            label = f"{sn} / {c['letter']}「{c['name']}」" if c["name"] else f"{sn} / {c['letter']}（無名）"
            rows.append({"properties": {
                "キュー": label, "曲": [page], "記号": c["letter"], "キュー名": c["name"],
                "位置": ms_to_str(c["positionMs"]), "位置ms": c["positionMs"],
                "種別": "Hot", "cueUUID": c["uuid"],
                # ループかどうかは押し方が変わる情報なので、曲ページ・グラフにも出す
                "ループ": bool(c.get("loop")), "ループ終ms": c.get("loopEndMs"),
            }})

    chunk = rows[start:start + count]
    print(f"# 全{len(rows)}件 / {start}..{start + len(chunk)} を出力 (残り {max(0, len(rows) - start - len(chunk))})", file=sys.stderr)
    print(json.dumps(chunk, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
