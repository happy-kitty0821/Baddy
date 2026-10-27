"""
Project-wide constants: coordinate conventions, pipeline versioning,
and court dimensions.

These values must not change without a corresponding migration or
analysis-version bump, because stored data depends on them.
"""

# ── Pipeline versioning ────────────────────────────────────────────────────
# Increment when the pipeline logic changes in a way that makes results
# from different versions incompatible.
PIPELINE_VERSION = "2.0.0"

# ── COCO keypoint skeleton (Phase 2 pose overlay) ─────────────────────────
# The pose model predicts 17 COCO keypoints (0-indexed):
#   0 nose, 1 left eye, 2 right eye, 3 left ear, 4 right ear,
#   5 left shoulder, 6 right shoulder, 7 left elbow, 8 right elbow,
#   9 left wrist, 10 right wrist, 11 left hip, 12 right hip,
#   13 left knee, 14 right knee, 15 left ankle, 16 right ankle.
COCO_KEYPOINT_COUNT = 17

# Skeleton connection pairs (0-indexed keypoint indices).  Drawn as lines
# between two keypoints by the frontend overlay.  Grouped as:
#   face  (0,1)(0,2)(1,3)(2,4)(1,2)(3,4)
#   torso (5,6)(5,11)(6,12)(11,12)
#   arms  (5,7)(7,9)(6,8)(8,10)
#   legs  (11,13)(13,15)(12,14)(14,16)
#   head-torso (0,5)
COCO_SKELETON_CONNECTIONS = [
    (0, 1), (0, 2), (1, 3), (2, 4), (1, 2), (3, 4),   # face
    (5, 6), (5, 11), (6, 12), (11, 12),               # torso
    (5, 7), (7, 9), (6, 8), (8, 10),                  # arms
    (11, 13), (13, 15), (12, 14), (14, 16),           # legs
    (0, 5),                                            # head-torso
]

# ── Court dimensions (BWF standard, metres) ───────────────────────────────
# Origin (0, 0) is the top-left corner of the court in the normalised
# top-down view.  X increases to the right; Y increases downward.
COURT_LENGTH_M = 13.40   # full length (doubles)
COURT_WIDTH_M = 6.10    # full width (doubles)
COURT_SINGLES_WIDTH_M = 5.18

# ── Coordinate conventions ────────────────────────────────────────────────
# All pixel coordinates stored in the database use the original video
# resolution at the time of analysis.  The (width, height) of the
# source video is stored in the match record and must be used when
# interpreting stored pixel coordinates.
#
# Normalised court coordinates are in metres, using the origin above.

# ── Confidence thresholds ─────────────────────────────────────────────────
# Minimum confidence for a joint to be drawn in the skeleton overlay.
POSE_DRAW_CONFIDENCE = 0.5

# Minimum confidence for a shuttle observation to be treated as detected
# (rather than interpolated).
SHUTTLE_DETECT_CONFIDENCE = 0.4

# ── Upload limits (defaults; overridable via env) ─────────────────────────
DEFAULT_MAX_UPLOAD_MB = 2048
DEFAULT_MAX_DURATION_MINUTES = 180

# ── Supported video MIME types ────────────────────────────────────────────
ALLOWED_VIDEO_MIME_TYPES = frozenset({
    "video/mp4",
    "video/quicktime",
    "video/x-msvideo",
    "video/x-matroska",
    "video/webm",
})

ALLOWED_VIDEO_EXTENSIONS = frozenset({
    ".mp4", ".mov", ".avi", ".mkv", ".webm",
})
