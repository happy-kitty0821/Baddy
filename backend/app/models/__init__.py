"""ORM models package.

Import all models here so that Alembic's env.py sees them when it
imports Base.metadata.
"""

from app.models.match import Match
from app.models.asset import Asset
from app.models.analysis_run import AnalysisRun
from app.models.player_track import PlayerTrack
from app.models.pose_frame import PoseFrame
from app.models.user_correction import UserCorrection

__all__ = [
    "Match",
    "Asset",
    "AnalysisRun",
    "PlayerTrack",
    "PoseFrame",
    "UserCorrection",
]
