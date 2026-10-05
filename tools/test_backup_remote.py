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
from backup_remote import RemoteBackup, path_key


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
            ), patch("backup_remote.tempfile.gettempdir", return_value=str(root)
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
        assert path_key(track.relative_to("/")) in remote.inventory("files")


def test_macos_case_alias():
    with fixture() as (remote, root, track, tracks):
        alias = track.parent / track.name.upper()
        if not alias.exists():
            return  # 大文字小文字を区別するファイルシステムでは同じファイルではない
        tracks.append(alias)
        tracks.append(track.parent.parent / "dj_songs" / track.name)
        assert remote.backup(False) == 0
        assert remote.verify_tracks(tracks) == 0


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
        remote.recover_library()
        assert (root / "backup/library/latest/rekordbox/master.db").read_bytes() == b"library-second"
        assert (root / "backup/library/previous/rekordbox/master.db").read_bytes() == b"library-first"


def library_db(root: Path, name: str) -> bytes:
    return (root / "backup/library" / name / "rekordbox/master.db").read_bytes()


def generation(remote, root: Path, number: int):
    (root / "rb/master.db").write_bytes(f"generation-{number}".encode())
    assert remote.backup(False) == 0


def test_stage_reuses_unchanged_files_on_fourth_backup():
    with fixture() as (remote, root, track, tracks):
        for number in range(1, 4):
            generation(remote, root, number)
        assert library_db(root, "latest") == b"generation-3"
        assert library_db(root, "previous") == b"generation-2"
        assert library_db(root, ".stage") == b"generation-1"
        unchanged = root / "backup/library/.stage/settings/normal.ini"
        old_inode = unchanged.stat().st_ino
        generation(remote, root, 4)
        assert library_db(root, "latest") == b"generation-4"
        assert library_db(root, "previous") == b"generation-3"
        assert library_db(root, ".stage") == b"generation-2"
        # 全転送した場合はinodeが変わる。既存ファイルをskipし、フォルダごと昇格している
        assert (root / "backup/library/latest/settings/normal.ini").stat().st_ino == old_inode
        assert remote.dirs("library") == {"latest", "previous", ".stage"}


def test_stage_verification_failure_preserves_latest_and_previous():
    with fixture() as (remote, root, track, tracks):
        for number in range(1, 4):
            generation(remote, root, number)
        (root / "rb/master.db").write_bytes(b"generation-4")
        real_run = remote.run

        def interrupted(*args, **kwargs):
            if args[0] == "check" and args[2] == remote.path("library/.stage"):
                raise RuntimeError("injected unverified stage failure")
            return real_run(*args, **kwargs)

        with patch.object(remote, "run", side_effect=interrupted):
            assert remote.backup(False) == 1
        assert library_db(root, "latest") == b"generation-3"
        assert library_db(root, "previous") == b"generation-2"
        assert ".verified" not in remote.dirs("library")
        generation(remote, root, 4)
        assert library_db(root, "latest") == b"generation-4"
        assert library_db(root, "previous") == b"generation-3"


def test_verified_recovery_initial_second_and_normal_rotation():
    # 各DirMove直前で止め、次のbackupが新しいstage syncより前に復旧することを確認する
    cases = [(0, "latest"), (1, "previous"), (1, "latest"),
             (3, ".stage"), (3, "previous"), (3, "latest")]
    for completed, interrupted_target in cases:
        with fixture() as (remote, root, track, tracks):
            for number in range(1, completed + 1):
                generation(remote, root, number)
            desired = f"generation-{completed + 1}".encode()
            (root / "rb/master.db").write_bytes(desired)
            real_run = remote.run

            def interrupted(*args, **kwargs):
                if args[0] == "moveto" and args[2] == remote.path(f"library/{interrupted_target}"):
                    raise RuntimeError("injected verified rotation interruption")
                return real_run(*args, **kwargs)

            with patch.object(remote, "run", side_effect=interrupted):
                assert remote.backup(False) == 1
            assert library_db(root, ".verified") == desired

            def stop_after_recovery(*args, **kwargs):
                if args[0] == "sync" and args[2] == remote.path("library/.stage"):
                    assert ".verified" not in remote.dirs("library")
                    assert library_db(root, "latest") == desired
                    raise RuntimeError("stop before fresh stage upload")
                return real_run(*args, **kwargs)

            with patch.object(remote, "run", side_effect=stop_after_recovery):
                assert remote.backup(False) == 1
            assert library_db(root, "latest") == desired
            if completed:
                assert library_db(root, "previous") == f"generation-{completed}".encode()
            if completed >= 2:
                assert library_db(root, ".stage") == f"generation-{completed - 1}".encode()


def test_legacy_latest_missing_recovery_is_atomic():
    with fixture() as (remote, root, track, tracks):
        generation(remote, root, 1)
        remote.run("moveto", remote.path("library/latest"), remote.path("library/previous"))
        real_run = remote.run

        def interrupted(*args, **kwargs):
            if args[0] == "check" and args[2] == remote.path("library/.legacy-recover"):
                raise RuntimeError("injected legacy recovery verification failure")
            return real_run(*args, **kwargs)

        with patch.object(remote, "run", side_effect=interrupted):
            assert remote.backup(False) == 1
        assert "latest" not in remote.dirs("library")
        assert library_db(root, "previous") == b"generation-1"
        remote.recover_library()
        assert library_db(root, "latest") == b"generation-1"
        assert library_db(root, "previous") == b"generation-1"
        assert ".legacy-recover" not in remote.dirs("library")


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print(f"PASS {test.__name__}", flush=True)
    print(f"{len(tests)}件すべて成功", flush=True)
