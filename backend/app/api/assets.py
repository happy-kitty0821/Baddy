"""
Asset streaming endpoint.

GET /api/assets/{asset_id}/stream  — stream a video file with HTTP range support
GET /api/assets/{asset_id}/info    — return asset metadata

Range request support is required for:
  - HTML5 <video> seeking (browsers send Range: bytes=X-Y).
  - Frame-by-frame inspection.
  - Resumable partial downloads.

Authentication:
  - Standard API routes use the Authorization: Bearer <token> header.
  - The native HTML <video> element cannot set request headers, so the
    stream endpoint additionally accepts a `token` query parameter.
  - The query-parameter token has the same expiry as the Bearer token.
  - The token is validated identically in both cases.
  - Never log the token value.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import Response, StreamingResponse

from app.auth.jwt import decode_token
from app.dependencies import DBSession, Storage
from app.schemas.asset import AssetRead
from app.services.asset_service import get_asset

router = APIRouter(prefix="/api/assets", tags=["assets"])

_CHUNK_SIZE = 1024 * 1024  # 1 MB


def _authenticate_stream(request: Request, token_param: str | None) -> str:
    """
    Authenticate a stream request via Bearer header OR ?token= query param.

    The query-parameter path exists solely for the HTML <video> element, which
    cannot set request headers.  Both paths validate the same JWT with the same
    expiry.  The token value is never logged.

    Raises HTTP 401 if no valid token is found.
    """
    # 1. Try Authorization: Bearer header first.
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return decode_token(auth_header[7:])

    # 2. Fall back to ?token= query parameter (for <video src>).
    if token_param:
        return decode_token(token_param)

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _parse_range_header(range_header: str, file_size: int) -> tuple[int, int]:
    """Parse 'Range: bytes=start-end' and return (start, end) inclusive."""
    unit, _, rng = range_header.partition("=")
    if unit.strip().lower() != "bytes":
        raise HTTPException(status_code=416, detail="Only byte ranges are supported")
    start_s, _, end_s = rng.partition("-")
    start = int(start_s) if start_s.strip() else 0
    end = int(end_s) if end_s.strip() else file_size - 1
    if start < 0 or end >= file_size or start > end:
        raise HTTPException(
            status_code=416,
            detail=f"Range not satisfiable: {range_header}",
            headers={"Content-Range": f"bytes */{file_size}"},
        )
    return start, end


@router.get("/{asset_id}/stream")
def stream_asset(
    asset_id: str,
    request: Request,
    db: DBSession,
    storage: Storage,
    token: str | None = Query(default=None, include_in_schema=False),
) -> Response:
    """
    Stream video bytes, supporting HTTP range requests for seeking.

    Accepts authentication via Authorization header or ?token= query param.
    The query-parameter path is required for the HTML <video> element.
    """
    _authenticate_stream(request, token)

    asset = get_asset(db, asset_id)
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")

    if not storage.exists(asset.storage_key):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Asset file is not currently accessible.",
        )

    file_size = storage.size(asset.storage_key)
    mime_type = asset.mime_type or "application/octet-stream"
    range_header = request.headers.get("range")

    if range_header:
        start, end = _parse_range_header(range_header, file_size)
        length = end - start + 1

        def _range_generator():
            f = storage.open(asset.storage_key)
            try:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(_CHUNK_SIZE, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk
            finally:
                f.close()

        return StreamingResponse(
            _range_generator(),
            status_code=206,
            media_type=mime_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(length),
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-store",
            },
        )
    else:
        # Full file
        def _full_generator():
            f = storage.open(asset.storage_key)
            try:
                while True:
                    chunk = f.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    yield chunk
            finally:
                f.close()

        return StreamingResponse(
            _full_generator(),
            status_code=200,
            media_type=mime_type,
            headers={
                "Content-Length": str(file_size),
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-store",
            },
        )


@router.get("/{asset_id}/info", response_model=AssetRead)
def get_asset_info(
    asset_id: str,
    request: Request,
    db: DBSession,
    storage: Storage,
    token: str | None = Query(default=None, include_in_schema=False),
) -> AssetRead:
    _authenticate_stream(request, token)
    asset = get_asset(db, asset_id)
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")
    return AssetRead.model_validate(asset)
