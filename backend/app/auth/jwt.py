"""
JWT authentication utilities.

Tokens are signed HS256 JWTs.  The payload contains:
  - sub: subject (username)
  - exp: expiry timestamp

For Phase 1, there is one built-in user whose credentials are read from
environment variables (AUTH_USERNAME / AUTH_PASSWORD).  A proper user
table will be added in a later phase when multi-user support is needed.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import settings

# bcrypt context for password hashing.
_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

_bearer = HTTPBearer(auto_error=True)


# ── Token creation ──────────────────────────────────────────────────────────

def create_access_token(subject: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {"sub": subject, "exp": expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


# ── Token verification ──────────────────────────────────────────────────────

def decode_token(token: str) -> str:
    """Decode and validate a JWT.  Returns the subject claim."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        sub: str | None = payload.get("sub")
        if sub is None:
            raise credentials_exception
        return sub
    except JWTError:
        raise credentials_exception


# ── FastAPI dependency ──────────────────────────────────────────────────────

def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> str:
    """FastAPI dependency: verifies Bearer token and returns the subject."""
    return decode_token(credentials.credentials)


# ── Password helpers ────────────────────────────────────────────────────────

def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_context.verify(plain, hashed)


def hash_password(plain: str) -> str:
    return _pwd_context.hash(plain)


# ── Single-user credential check (Phase 1) ─────────────────────────────────

def authenticate_user(username: str, password: str) -> bool:
    """
    Validate credentials against the values loaded from .env by Pydantic Settings.

    IMPORTANT: This reads from app.config.settings (which loads .env), NOT from
    os.getenv() — os.getenv() does not see .env file values.

    AUTH_PASSWORD must be a bcrypt hash.  Generate one with:
        python -c "from passlib.context import CryptContext; \
                   print(CryptContext(['bcrypt']).hash('yourpassword'))"

    If AUTH_USERNAME is not set, any login attempt fails.
    """
    from app.config import settings

    if not settings.auth_username or not settings.auth_password_hash:
        return False
    if username != settings.auth_username:
        return False
    return verify_password(password, settings.auth_password_hash)
