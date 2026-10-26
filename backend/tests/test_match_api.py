"""Integration tests for the match API endpoints.

These tests use an in-memory SQLite database and a temporary storage
directory.  No Docker, Redis, or network access is required.
"""

from __future__ import annotations

import io
import json

import pytest


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_upload_requires_auth(client, small_video):
    with open(small_video, "rb") as f:
        r = client.post(
            "/api/matches",
            data={"title": "Test Match"},
            files={"video": ("test.mp4", f, "video/mp4")},
        )
    assert r.status_code == 403


def test_upload_match(client, auth_headers, small_video):
    with open(small_video, "rb") as f:
        r = client.post(
            "/api/matches",
            data={"title": "My First Match", "tags": '["training"]'},
            files={"video": ("game.mp4", f, "video/mp4")},
            headers=auth_headers,
        )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["title"] == "My First Match"
    assert body["id"]
    assert body["source_asset_id"]
    assert body["tags"] == ["training"]


def test_list_matches_empty(client, auth_headers):
    r = client.get("/api/matches", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["items"] == []
    assert body["total"] == 0


def test_list_matches_after_upload(client, auth_headers, small_video):
    with open(small_video, "rb") as f:
        client.post(
            "/api/matches",
            data={"title": "Listed Match"},
            files={"video": ("v.mp4", f, "video/mp4")},
            headers=auth_headers,
        )
    r = client.get("/api/matches", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["title"] == "Listed Match"


def test_get_match(client, auth_headers, small_video):
    with open(small_video, "rb") as f:
        upload = client.post(
            "/api/matches",
            data={"title": "Get Me"},
            files={"video": ("v.mp4", f, "video/mp4")},
            headers=auth_headers,
        )
    match_id = upload.json()["id"]
    r = client.get(f"/api/matches/{match_id}", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["id"] == match_id


def test_get_nonexistent_match(client, auth_headers):
    r = client.get("/api/matches/does-not-exist", headers=auth_headers)
    assert r.status_code == 404


def test_update_match_metadata(client, auth_headers, small_video):
    with open(small_video, "rb") as f:
        upload = client.post(
            "/api/matches",
            data={"title": "Original Title"},
            files={"video": ("v.mp4", f, "video/mp4")},
            headers=auth_headers,
        )
    match_id = upload.json()["id"]
    r = client.patch(
        f"/api/matches/{match_id}",
        json={"title": "Updated Title", "notes": "Some notes"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["title"] == "Updated Title"
    assert r.json()["notes"] == "Some notes"


def test_delete_match(client, auth_headers, small_video, test_storage):
    with open(small_video, "rb") as f:
        upload = client.post(
            "/api/matches",
            data={"title": "Delete Me"},
            files={"video": ("v.mp4", f, "video/mp4")},
            headers=auth_headers,
        )
    match_id = upload.json()["id"]
    asset_id = upload.json()["source_asset_id"]

    # Delete
    r = client.delete(f"/api/matches/{match_id}", headers=auth_headers)
    assert r.status_code == 204

    # Match no longer accessible
    r2 = client.get(f"/api/matches/{match_id}", headers=auth_headers)
    assert r2.status_code == 404

    # Match does not appear in library
    r3 = client.get("/api/matches", headers=auth_headers)
    assert all(m["id"] != match_id for m in r3.json()["items"])


def test_upload_invalid_mime_type(client, auth_headers, tmp_path):
    fake = tmp_path / "doc.pdf"
    fake.write_bytes(b"%PDF-fake")
    with open(fake, "rb") as f:
        r = client.post(
            "/api/matches",
            data={"title": "Invalid"},
            files={"video": ("doc.pdf", f, "application/pdf")},
            headers=auth_headers,
        )
    assert r.status_code == 422


def test_pagination(client, auth_headers, small_video):
    for i in range(5):
        with open(small_video, "rb") as f:
            client.post(
                "/api/matches",
                data={"title": f"Match {i}"},
                files={"video": ("v.mp4", f, "video/mp4")},
                headers=auth_headers,
            )
    r = client.get("/api/matches?page=1&page_size=3", headers=auth_headers)
    body = r.json()
    assert body["total"] == 5
    assert len(body["items"]) == 3
    assert body["total_pages"] == 2


def test_video_stream_range_request(client, auth_headers, small_video):
    """Video streaming endpoint must support HTTP range requests for seeking."""
    with open(small_video, "rb") as f:
        upload = client.post(
            "/api/matches",
            data={"title": "Stream Test"},
            files={"video": ("v.mp4", f, "video/mp4")},
            headers=auth_headers,
        )
    asset_id = upload.json()["source_asset_id"]

    # Full request
    r = client.get(f"/api/assets/{asset_id}/stream", headers=auth_headers)
    assert r.status_code == 200
    assert "accept-ranges" in r.headers

    # Range request
    file_size = int(r.headers["content-length"])
    if file_size >= 10:
        r2 = client.get(
            f"/api/assets/{asset_id}/stream",
            headers={**auth_headers, "Range": "bytes=0-9"},
        )
        assert r2.status_code == 206
        assert len(r2.content) == 10
        assert "content-range" in r2.headers
