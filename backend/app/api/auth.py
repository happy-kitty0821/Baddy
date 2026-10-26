"""Authentication endpoints."""

from fastapi import APIRouter, HTTPException, status

from app.auth.jwt import authenticate_user, create_access_token, get_current_user
from app.config import settings
from app.dependencies import CurrentUser
from app.schemas.auth import LoginRequest, TokenResponse, UserRead

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest) -> TokenResponse:
    if not authenticate_user(body.username, body.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )
    token = create_access_token(subject=body.username)
    return TokenResponse(
        access_token=token,
        expires_in=settings.jwt_expire_minutes * 60,
    )


@router.get("/me", response_model=UserRead)
def get_me(current_user: CurrentUser) -> UserRead:
    """Return the authenticated user. Used by the frontend to validate a stored token."""
    return UserRead(username=current_user)
