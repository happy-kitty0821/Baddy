"""
Shared enumerations used by both the backend API and the Celery worker.

Keeping these in one place prevents drift between the two packages and
ensures database-stored string values remain consistent across migrations.
"""

from enum import Enum


class MatchStatus(str, Enum):
    """Overall processing status of a match record."""
    PENDING = "pending"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"
    DELETED = "deleted"


class AnalysisStatus(str, Enum):
    """Lifecycle status of a single analysis run."""
    QUEUED = "queued"
    INGESTING = "ingesting"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AssetType(str, Enum):
    """Categories of stored file assets."""
    VIDEO_ORIGINAL = "video_original"
    VIDEO_ANNOTATED = "video_annotated"
    THUMBNAIL = "thumbnail"
    PREVIEW_CLIP = "preview_clip"
    COACHING_REPORT = "coaching_report"


class ObservationStatus(str, Enum):
    """Quality classification for a shuttle or player observation."""
    DETECTED = "detected"
    INTERPOLATED = "interpolated"
    PREDICTED = "predicted"
    UNAVAILABLE = "unavailable"


class ShotType(str, Enum):
    """Badminton shot classifications."""
    SERVE = "serve"
    CLEAR = "clear"
    SMASH = "smash"
    DROP = "drop"
    DRIVE = "drive"
    LIFT = "lift"
    NET_SHOT = "net_shot"
    BLOCK = "block"
    PUSH = "push"
    UNKNOWN = "unknown"


class ReviewStatus(str, Enum):
    """Whether an event has been manually reviewed or corrected."""
    AUTO = "auto"
    REVIEWED = "reviewed"
    CORRECTED = "corrected"


class VisionStage(str, Enum):
    """Stages of the Phase 2 vision pipeline (player detection + pose)."""
    LOAD_VIDEO = "load_video"
    LOAD_MODEL = "load_model"
    DETECT_PLAYERS = "detect_players"
    TRACK_AND_POSE = "track_and_pose"
    SAVE_RESULTS = "save_results"
    FINALIZE = "finalize"
