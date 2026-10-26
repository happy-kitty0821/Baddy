"""Unit tests for the LocalFileStorage backend."""

from __future__ import annotations

import io
import pytest

from app.storage.local import LocalFileStorage


@pytest.fixture()
def storage(tmp_path) -> LocalFileStorage:
    return LocalFileStorage(root=tmp_path)


def test_store_and_read(storage):
    data = b"hello, badminton"
    n = storage.store("videos/abc/test.mp4", io.BytesIO(data))
    assert n == len(data)
    result = storage.open("videos/abc/test.mp4").read()
    assert result == data


def test_exists_true(storage):
    storage.store("test/file.bin", io.BytesIO(b"x"))
    assert storage.exists("test/file.bin") is True


def test_exists_false(storage):
    assert storage.exists("nonexistent/file.bin") is False


def test_size(storage):
    data = b"size test" * 100
    storage.store("test/size.bin", io.BytesIO(data))
    assert storage.size("test/size.bin") == len(data)


def test_delete(storage):
    storage.store("test/del.bin", io.BytesIO(b"delete me"))
    storage.delete("test/del.bin")
    assert storage.exists("test/del.bin") is False


def test_delete_nonexistent_raises(storage):
    with pytest.raises(FileNotFoundError):
        storage.delete("does/not/exist.bin")


def test_open_nonexistent_raises(storage):
    with pytest.raises(FileNotFoundError):
        storage.open("no/such/file.bin")


def test_path_traversal_rejected(storage):
    with pytest.raises(ValueError):
        storage.store("../../etc/passwd", io.BytesIO(b"evil"))


def test_resolve_path(storage):
    storage.store("vids/x/v.mp4", io.BytesIO(b"video"))
    p = storage.resolve_path("vids/x/v.mp4")
    assert p.exists()
    assert p.read_bytes() == b"video"


def test_overwrite_is_atomic(storage):
    """Second store replaces the first atomically."""
    storage.store("test/overwrite.bin", io.BytesIO(b"first"))
    storage.store("test/overwrite.bin", io.BytesIO(b"second"))
    assert storage.open("test/overwrite.bin").read() == b"second"
