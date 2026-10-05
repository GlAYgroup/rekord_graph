"""実機・iCloud・Driveに触れず、rclone local backendでバックアップを検証する"""
from __future__ import annotations

import os
import shutil
import tempfile
import unicodedata
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import backup as local
from backup_remote import RemoteBackup


@contextmanager
def fixture():
    binary = shutil.which("rclone")
    if not binary:
        raise RuntimeError("この統合テストはrcloneが必要です")
    with tempfile.TemporaryDirectory(prefix="rekord_graph_remote_test-") as directory:
        root = Path(directory)
        config = root / "rclone.conf"
        config.write_text("[test]\ntype = local\n")
        music, rb, settings, repo = (root / name for name in ("Music", "rb", "settings", "repo"))
        songs = music / "DJ_songs"
        for path in (songs, rb, settings, repo / "data"):
            path.mkdir(parents=True)
        track = songs / unicodedata.normalize("NFD", "テスト曲.mp3")
        track.write_bytes(b"original-track")
        (rb / "master.db").write_bytes(b"library-first")
        (settings / "rb_guser").write_text("secret-excluded")
        (settings / "normal.ini").write_text("settings")
        tracks = [track]
        previous_cwd = Path.cwd()
        try:
            os.chdir(root)
            with patch.dict(os.environ, {"RCLONE_CONFIG": str(config)}), patch.multiple(
                local, MUSIC=music, RB_DIR=rb, SETTINGS_DIR=settings, REPO=repo, ALWAYS=[]
            ), patch.object(local, "track_paths", side_effect=lambda *_: list(tracks)), patch(
                "backup_remote.assert_closed", return_value=True
            ):
                yield RemoteBackup("test:backup", binary), root, track, tracks
        finally:
            os.chdir(previous_cwd)


def mirrored(root: Path, track: Path, prefix: str = "files") -> Path:
    return root / "backup" / prefix / track.relative_to("/")


def test_initial_unicode_and_secrets():
    with fixture() as (remote, root, track, tracks):
        assert remote.backup(False) == 0
        assert mirrored(root, track).read_bytes() == track.read_bytes()
        latest = root / "backup/library/latest"
        assert (latest / "rekordbox/master.db").read_bytes() == b"library-first"
        assert not (latest / "settings/rb_guser").exists()
        assert remote.verify_tracks([Path(unicodedata.normalize("NFC", str(track)))]) == 0
        assert local.key(track.relative_to("/")) in remote.inventory("files")


def test_update_delete_and_one_previous():
    with fixture() as (remote, root, track, tracks):
        extra = track.parent / "unregistered.txt"
        extra.write_bytes(b"unregistered-original")
        assert remote.backup(False) == 0
        extra.unlink()
        track.write_bytes(b"changed-track-content")
        (root / "rb/master.db").write_bytes(b"library-second")
        assert remote.backup(False) == 0
        assert mirrored(root, track).read_bytes() == b"changed-track-content"
        assert mirrored(root, track, "previous/files").read_bytes() == b"original-track"
        assert mirrored(root, extra, "previous/files").read_bytes() == b"unregistered-original"
        assert not mirrored(root, extra).exists()
        assert (root / "backup/library/previous/rekordbox/master.db").read_bytes() == b"library-first"
        assert remote.backup(False) == 0
        assert not (root / "backup/previous/files").exists()


def test_interruption_keeps_library_and_retired_tracks():
    with fixture() as (remote, root, track, tracks):
        assert remote.backup(False) == 0
        track.write_bytes(b"updated-after-initial")
        real_run = remote.run

        def interrupted(*args, **kwargs):
            if args[0] == "check" and args[2] == remote.path("files"):
                raise RuntimeError("injected transfer verification interruption")
            return real_run(*args, **kwargs)

        with patch.object(remote, "run", side_effect=interrupted):
            assert remote.backup(False) == 1
        assert (root / "backup/library/latest/rekordbox/master.db").read_bytes() == b"library-first"
        retired = list((root / "backup/.incomplete").rglob(track.name))
        assert len(retired) == 1 and retired[0].read_bytes() == b"original-track"
        assert remote.backup(False) == 0
        assert retired[0].read_bytes() == b"original-track"


def test_missing_source_aborts_before_remote_changes():
    with fixture() as (remote, root, track, tracks):
        assert remote.backup(False) == 0
        track.unlink()
        (root / "rb/master.db").write_bytes(b"invalid-new-generation")
        assert remote.backup(False) == 1
        assert mirrored(root, track).read_bytes() == b"original-track"
        assert (root / "backup/library/latest/rekordbox/master.db").read_bytes() == b"library-first"


def test_library_rotation_interruption_recovers():
    with fixture() as (remote, root, track, tracks):
        assert remote.backup(False) == 0
        (root / "rb/master.db").write_bytes(b"library-second")
        real_run = remote.run

        def interrupted(*args, **kwargs):
            if args[0] == "moveto" and args[2] == remote.path("library/latest"):
                raise RuntimeError("injected library promotion interruption")
            return real_run(*args, **kwargs)

        with patch.object(remote, "run", side_effect=interrupted):
            assert remote.backup(False) == 1
        assert (root / "backup/library/previous/rekordbox/master.db").read_bytes() == b"library-first"
        assert remote.backup(False) == 0
        assert (root / "backup/library/latest/rekordbox/master.db").read_bytes() == b"library-second"
        assert (root / "backup/library/previous/rekordbox/master.db").read_bytes() == b"library-first"


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print(f"PASS {test.__name__}", flush=True)
    print(f"{len(tests)}件すべて成功", flush=True)
