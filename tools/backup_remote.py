"""rcloneで曲を直接送信し、ライブラリだけ一時コピーするバックアップ経路"""
from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import backup as local

LOCK_ROOT = local.REPO / ".backup-state"
LOCK_NAME = f"rekord_graph_remote_backup-{os.getuid()}.lock" if os.name == "posix" else "rekord_graph_remote_backup.lock"


def path_key(path: Path | str) -> str:
    normalized = local.key(path)
    # このMacの通常のAPFSでは大文字小文字の違うDB参照も同じファイルを指す
    return normalized.casefold() if sys.platform == "darwin" else normalized


def assert_closed() -> bool:
    result = subprocess.run(["pgrep", "-x", "rekordbox"], capture_output=True)
    if result.returncode == 0:
        print("rekordbox が起動中なのでスキップします", flush=True)
        return False
    if result.returncode != 1:
        raise RuntimeError("rekordboxの起動状態を確認できないため停止します")
    return True


def wanted_files(tracks: list[Path]) -> dict[str, Path]:
    roots, singles = local.sources(tracks)
    wanted: dict[str, Path] = {}
    for root in roots:
        if not root.is_dir():
            raise RuntimeError(f"同期元フォルダがありません: {root}")
        for path in root.rglob("*"):
            if path.is_file() and path.name not in local.JUNK:
                normalized = path_key(path)
                if normalized in wanted and not path.samefile(wanted[normalized]):
                    raise RuntimeError(f"正規化後のパスが重複しています: {path}")
                wanted.setdefault(normalized, path)
    for path in singles + tracks:
        if not path.is_file():
            raise RuntimeError(f"DB参照曲がありません: {path}")
        normalized = path_key(path)
        if normalized in wanted and not path.samefile(wanted[normalized]):
            raise RuntimeError(f"正規化後のパスが重複しています: {path}")
        wanted.setdefault(normalized, path)
    if not wanted:
        raise RuntimeError("同期元が空なので送信先を更新しません")
    return wanted


class RemoteBackup:
    def __init__(self, dest: str, binary: str | None = None):
        # Drive全体をsync/purgeしないよう、名前付きremoteと専用子フォルダが必須
        if not re.fullmatch(r"[\w-]+:[^:]+", dest):
            raise ValueError("--remote は remote:専用フォルダ を指定してください")
        name, folder = dest.split(":", 1)
        if folder.startswith("/") or any(p in ("", ".", "..") for p in folder.split("/")):
            raise ValueError("送信先にルート・空要素・相対パスは指定できません")
        self.dest = f"{name}:{folder}"
        found = shutil.which(binary or "rclone")
        if not found:
            raise RuntimeError("rcloneが見つかりません（brew install rclone）")
        self.binary = str(Path(found).absolute())

    def path(self, suffix: str) -> str:
        return f"{self.dest}/{suffix}"

    def run(self, *args: str, capture: bool = False) -> str:
        # ライブラリは小ファイルが多いので、音源より同時転送数を増やす
        transfers = "32" if args[0] == "sync" and "--copy-links" not in args else "8"
        result = subprocess.run(
            [self.binary, *map(str, args), "--transfers", transfers, "--checkers", "8",
             "--fast-list", "--no-update-dir-modtime",
             "--stats", "30s", "--stats-one-line", "--stats-log-level", "NOTICE",
             "--log-level", "NOTICE"],
            check=True, text=True, stdout=subprocess.PIPE if capture else None,
        )
        return result.stdout or ""

    def dirs(self, suffix: str = "") -> set[str]:
        return {row["Name"] for row in json.loads(self.run(
            "lsjson", self.path(suffix) if suffix else self.dest, "--dirs-only", capture=True))}

    def remove_dir(self, suffix: str) -> None:
        parent, _, name = suffix.rpartition("/")
        if name in self.dirs(parent):
            self.run("purge", self.path(suffix))

    def inventory(self, suffix: str) -> dict[str, int]:
        rows = json.loads(self.run("lsjson", self.path(suffix), "-R", "--files-only", capture=True))
        found: dict[str, int] = {}
        for row in rows:
            path = path_key(row["Path"])
            if path in found:
                raise RuntimeError(f"送信先に重複パスがあります: {path}")
            found[path] = row["Size"]
        return found

    def verify_tracks(self, tracks: list[Path]) -> int:
        found = self.inventory("files")
        failures = []
        for path in tracks:
            relative = path_key(path.relative_to("/"))
            if not path.is_file() or found.get(relative) != path.stat().st_size:
                failures.append(str(path))
        print(f"DB参照曲: {len(tracks)} 件 / 欠け・サイズ不一致: {len(failures)} 件", flush=True)
        for path in failures:
            print(f"  ! {path}")
        return 1 if failures else 0

    def recover_library(self) -> None:
        """検証済み候補の世代入替を前進させる。未検証.stageは昇格しない"""
        names = self.dirs("library")
        if ".verified" in names:
            latest, previous, stage = (name in names for name in ("latest", "previous", ".stage"))
            if (latest and previous and stage) or (not latest and not previous and stage):
                raise RuntimeError("ライブラリ世代の中断状態が想定外なので停止します")
            # previousを退避した後にlatest→previous、最後に検証済み候補を昇格する
            if latest and previous:
                self.run("moveto", self.path("library/previous"), self.path("library/.stage"))
            if latest:
                self.run("moveto", self.path("library/latest"), self.path("library/previous"))
            self.run("moveto", self.path("library/.verified"), self.path("library/latest"))
            return

        # 旧実装でlatest→previousの後に止まった場合。コピー中断でもlatestを半完成にしない
        if "latest" not in names and "previous" in names:
            recovery = self.path("library/.legacy-recover")
            self.run("sync", self.path("library/previous"), recovery)
            self.run("check", self.path("library/previous"), recovery)
            self.run("moveto", recovery, self.path("library/latest"))
        elif ".legacy-recover" in names:
            raise RuntimeError("旧方式の復旧途中の状態が想定外なので停止します")

    def backup(self, dry: bool) -> int:
        print(f"[{dt.datetime.now():%Y-%m-%d %H:%M}] 同期先: {self.dest}", flush=True)
        try:
            # macOSの一時領域清掃に古いmtimeのsnapshotを消されない場所を共有する
            LOCK_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
            with open(LOCK_ROOT / LOCK_NAME, "a") as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    print("別のリモートバックアップが実行中なのでスキップします")
                    return 0
                if not assert_closed():
                    return 0
                return self._backup(dry)
        except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
            print(f"バックアップ失敗: {error}", flush=True)
            return 1

    def _backup(self, dry: bool) -> int:
        # OAuthや接続エラーはローカルsnapshotを作る前に確認
        self.run("lsjson", self.dest.split(":", 1)[0] + ":", "--dirs-only", capture=True)
        if dry:
            wanted = wanted_files(local.track_paths())
            print(f"曲ファイル {len(wanted)} 件。曲は複製せず直接送信、ライブラリだけ一時コピー")
            print("（--dry-run: 何も書いていません）")
            return 0

        # .verifiedが残っていれば新しい.stageを更新する前に、検証済み世代の入替を完了する
        self.run("mkdir", self.path("library"))
        self.recover_library()

        with tempfile.TemporaryDirectory(prefix="rekord_graph_upload-", dir=LOCK_ROOT) as temp:
            stage = Path(temp)
            required = sum(p.stat().st_size for root in (local.RB_DIR, local.SETTINGS_DIR, local.REPO / "data")
                           for p in root.rglob("*") if p.is_file() and not local.skip_secret(p.name))
            if shutil.disk_usage(stage).free < required + 1024**3:
                raise RuntimeError("ライブラリの一時コピーと1GiBの余裕を確保できません")
            if not (local.RB_DIR / "master.db").is_file():
                raise RuntimeError("master.dbがありません")
            local.sync_library(stage, False)
            if not assert_closed():
                raise RuntimeError("ライブラリコピー中にrekordboxが起動したため停止します")
            tracks = local.track_paths(stage / "library/latest/rekordbox/master.db")
            wanted = wanted_files(tracks)
            files = stage / "files"
            files.mkdir()
            for source in wanted.values():
                link = files / source.relative_to("/")
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(source)
            print(f"曲ファイル: {len(wanted)} 件 / DB参照曲: {len(tracks)} 件", flush=True)

            # 失敗した実行の退避は消さずに保持。再試行が以前の曲を上書きしない
            run_id = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f") + f"-{os.getpid()}"
            pending = f".incomplete/{run_id}"
            self.run("mkdir", self.path(pending))
            self.run("sync", str(files), self.path("files"), "--copy-links",
                     "--backup-dir", self.path(f"{pending}/files"), "--delete-after")
            self.run("check", str(files), self.path("files"), "--copy-links", "--size-only")
            if self.verify_tracks(tracks):
                raise RuntimeError("DB参照曲の照合に失敗しました")

            # 3世代目以降の古い完成済みフォルダを再利用し、小ファイルを毎回送らない
            new = "library/.stage"
            self.run("sync", str(stage / "library/latest"), self.path(new))
            self.run("check", str(stage / "library/latest"), self.path(new))
            self.run("moveto", self.path(new), self.path("library/.verified"))
            self.recover_library()
            self.run("mkdir", self.path("previous"))
            self.remove_dir("previous/files")
            if "files" in self.dirs(pending):
                self.run("moveto", self.path(f"{pending}/files"), self.path("previous/files"))
            self.remove_dir(pending)
            print("Google Driveへの同期と照合が完了しました", flush=True)
            return 0
