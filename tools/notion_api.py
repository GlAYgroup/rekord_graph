#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Notion API の薄いラッパー。

MCP 経由のクエリにはワークスペースの利用上限があるため、同期ツールは
公式 API を直接叩く。トークンと database ID は `config.py` が
環境変数 / ~/.config/rekord_graph/config.json から読む（リポジトリには置かない）。

セットアップ手順は README.md の「セットアップ」を参照。
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import config

API = "https://api.notion.com/v1"
VERSION = "2022-06-28"  # データベース単位のクエリが使える安定版


class _LazyConfig(dict):
    """database ID の辞書。最初に触ったときに読む（import しただけでは設定を要求しない）。"""

    _loaded = False

    def _load(self) -> None:
        if not self._loaded:
            self._loaded = True
            dict.update(self, config.notion_databases())

    def __getitem__(self, key):  # type: ignore[override]
        self._load()
        return dict.__getitem__(self, key)

    def get(self, key, default=None):  # type: ignore[override]
        self._load()
        return dict.get(self, key, default)

    def __contains__(self, key):  # type: ignore[override]
        self._load()
        return dict.__contains__(self, key)

    def __iter__(self):
        self._load()
        return dict.__iter__(self)

    def __len__(self):
        self._load()
        return dict.__len__(self)

    def keys(self):  # type: ignore[override]
        self._load()
        return dict.keys(self)

    def items(self):  # type: ignore[override]
        self._load()
        return dict.items(self)

    def values(self):  # type: ignore[override]
        self._load()
        return dict.values(self)


# 🎵Tracks / 📍Cues / 🔀Transitions / 🗺️Layouts の database ID
CONFIG: dict[str, str] = _LazyConfig()


class NotionError(RuntimeError):
    pass


def _token() -> str:
    try:
        return config.notion_token()
    except config.ConfigError as e:
        raise NotionError(str(e)) from e


def request(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{API}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {_token()}",
            "Notion-Version": VERSION,
            "Content-Type": "application/json",
        },
    )
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            if e.code == 429:  # レート制限。Retry-After に従う
                time.sleep(float(e.headers.get("Retry-After", 1)) + attempt)
                continue
            raise NotionError(f"{method} {path} -> {e.code}: {detail}") from e
    raise NotionError(f"{method} {path}: レート制限が続いたため中断")


def query_all(data_source_id: str) -> list[dict]:
    """データベースの全ページを取得する（ページネーション込み）。"""
    out, cursor = [], None
    while True:
        body = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        res = request("POST", f"/databases/{data_source_id}/query", body)
        out.extend(res["results"])
        if not res.get("has_more"):
            return out
        cursor = res["next_cursor"]


def plain(prop: dict | None) -> str:
    """rich_text / title プロパティを素のテキストにする。"""
    if not prop:
        return ""
    items = prop.get("rich_text") or prop.get("title") or []
    return "".join(i.get("plain_text", "") for i in items)


def select_name(prop: dict | None) -> str | None:
    return (prop or {}).get("select", {}).get("name") if (prop or {}).get("select") else None


def text_prop(value: str) -> dict:
    return {"rich_text": [{"type": "text", "text": {"content": value}}]}


def title_prop(value: str) -> dict:
    return {"title": [{"type": "text", "text": {"content": value}}]}
