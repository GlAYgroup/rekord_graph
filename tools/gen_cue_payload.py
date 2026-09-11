#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""data/rekordbox.json -> Notion 📍Cues への投入ペイロード（バッチ分割）。

キューのタイトルは「短縮名 / 記号「キュー名」」。
Notion のリレーション選択はタイトルの部分一致で絞れるので、
Transitions で曲名を打てばその曲のキューだけが並ぶ。
"""
import json, re, sys
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
    return re.split(r"[(\[（［]", title)[0].strip()[:24] or title[:24]


REMIX_WORD = re.compile(r"(?i)^(remix|bootleg|edit|flip|vip|mix|ver|version|remaster|&)$")


def _uniq(xs: list) -> list:
    out, seen = [], set()
    for x in xs:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def tag_candidates(title: str) -> list:
    """短縮名が衝突したときに付ける識別子の**候補**。前から順に試す。

    「先頭の語 → 末尾の語 → 全部つなげたもの」の順。1つでは足りない:
    `フォニイ（unknown bootleg・0db）` と `フォニイ（unknown bootleg・phony）` は
    **先頭の語がどちらも unknown** なので、末尾まで見ないと区別が付かない。
    """
    for m in re.findall(r"[(（\[]([^)）\]]+)[)）\]]", title):
        m = m.strip()
        if not m or re.match(r"(?i)^(ft\.|feat\.)", m):
            continue  # 「ft. 重音テト」等は曲の区別にならない
        # 「・」でも割る（リミキサー名の後ろに版の違いが付くことがある）。
        # **数字だけの語**（`(2)` `(2019)`）は区別にならないので落とす。
        # 以前は「先頭が数字の語」を丸ごと捨てていたため `6Tan` のような名前まで弾かれ、
        # フォールバックのゴミ（`フォニイ(フォニイ（6Tan bo)`）が表示名になっていた
        parts = [p for p in re.split(r"[\s・]+", m) if p and not re.fullmatch(r"[\d.]+", p)]
        if not parts:
            continue
        core = [p for p in parts if not REMIX_WORD.match(p)] or parts
        return _uniq([core[0][:12], core[-1][:12], " ".join(core)[:20]])
    # 括弧が無い形（`..._Wipecore_VIP_Remix_v3`）。最後の `_` の後ろを使う
    tail = title.split("_")[-1].strip()
    return _uniq([tail[:12]]) if tail and tail != title else []


def build_short_names(tracks: list) -> dict:
    """曲ID -> **一意な**短縮名。衝突したものだけ識別子を付ける。

    ここが曖昧だと、Notion の 📍Cues でどの曲のキューか見分けが付かない
    （リレーションの候補もこの名前で絞る）。**一意であることを必ず保証する。**

    識別子を付けるのは衝突したものだけ。原曲そのもの（括弧が無い）は素の曲名のまま
    残るので、`人マニア` と `人マニア(Nemonoika)` のように自然に分かれる。
    """
    groups: dict[str, list] = {}
    for t in tracks:
        groups.setdefault(base_name(t["title"]), []).append(t)
    out = {}
    for base, ts in groups.items():
        if len(ts) == 1:
            out[ts[0]["id"]] = base
            continue
        ts = sorted(ts, key=lambda t: t["id"])  # 同じ入力なら毎回同じ名前になるように
        cands = {t["id"]: tag_candidates(t["title"]) for t in ts}
        names: dict = {}
        for depth in range(3):
            names = {}
            for t in ts:
                c = cands[t["id"]]
                names[t["id"]] = f"{base}({c[min(depth, len(c) - 1)]})" if c else base
            if len(set(names.values())) == len(ts):
                break
        else:
            # **ここが一意性の最後の砦**（候補を使い切っても重なった場合）。
            # 消さないこと。id 順に振るので、実行するたびに名前が入れ替わることはない
            seen: dict = {}
            for t in ts:
                n = names[t["id"]]
                seen[n] = seen.get(n, 0) + 1
                if seen[n] > 1:
                    names[t["id"]] = f"{n}#{seen[n]}"
        out.update(names)
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
