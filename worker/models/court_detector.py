"""
Court keypoint detector for Phase 3 calibration.

Detects badminton court line intersections and computes a perspective
homography mapping source pixels → normalised court coordinates [0,1]×[0,1].

All cv2/numpy imports are LAZY (inside function bodies) so this module can
be imported in test environments where OpenCV is not installed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass
class CourtDetectionResult:
    corners: list[list[float]]           # 4 [x,y] in source pixels, or empty
    homography: list[list[float]] | None  # 3×3 as list-of-lists, or None
    confidence: float                    # 0–1, fraction of expected intersections found
    intersections: list[list[float]]     # all detected intersections


def detect_court_keypoints(
    frame,
    source_width: int,
    source_height: int,
) -> CourtDetectionResult:
    """
    Detect the 4 court corners from a BGR video frame.

    Strategy:
      1. Colour-threshold to find the court surface (handles green or blue courts).
      2. Find the largest contour → approxPolyDP → if a clean quad, use it.
      3. Fallback: Canny + HoughLinesP → cluster H/V lines → pairwise intersections
         → cluster nearby intersections → take 4 extremal corners from convex hull.
      4. Compute getPerspectiveTransform corners → [[0,0],[1,0],[1,1],[0,1]].
      5. confidence = min(1.0, len(intersections) / 12.0)
    """
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    h, w = frame.shape[:2]

    # ── Step 1: Colour threshold ──────────────────────────────────────────
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

    # Green court (H=25-95, S=30-255, V=30-255) — wider range covers
    # bright lime, dark forest, and blue-green indoor court surfaces
    green_mask = cv2.inRange(
        hsv,
        np.array([25, 30, 30]),
        np.array([95, 255, 255]),
    )
    # Blue court (H=90-140, S=40-255, V=40-255)
    blue_mask = cv2.inRange(
        hsv,
        np.array([90, 40, 40]),
        np.array([140, 255, 255]),
    )

    # Use whichever mask has more non-zero pixels
    court_mask = green_mask if cv2.countNonZero(green_mask) >= cv2.countNonZero(blue_mask) else blue_mask

    # ── Step 2: Morphological close + largest contour ────────────────────
    kernel = np.ones((5, 5), np.uint8)
    closed = cv2.morphologyEx(court_mask, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    corners: list[list[float]] = []
    intersections: list[list[float]] = []

    if contours:
        largest = max(contours, key=cv2.contourArea)
        peri = cv2.arcLength(largest, True)
        approx = cv2.approxPolyDP(largest, 0.02 * peri, True)

        if len(approx) == 4:
            # Got a clean quadrilateral — order: TL, TR, BR, BL
            pts = approx.reshape(4, 2).tolist()
            pts = _order_corners(pts)
            corners = [[float(x), float(y)] for x, y in pts]
            # Treat corners as our intersections too
            intersections = list(corners)

    # ── Step 3: Fallback via HoughLinesP ──────────────────────────────────
    if not corners:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 50, 150)
        lines = cv2.HoughLinesP(
            edges,
            rho=1,
            theta=math.pi / 180,
            threshold=80,
            minLineLength=w * 0.1,
            maxLineGap=20,
        )

        if lines is not None:
            h_lines: list = []
            v_lines: list = []
            for line in lines:
                x1, y1, x2, y2 = line[0]
                angle = abs(math.degrees(math.atan2(y2 - y1, x2 - x1)))
                if angle < 15 or angle > 165:
                    h_lines.append(line[0])
                elif 75 < angle < 105:
                    v_lines.append(line[0])

            # Compute pairwise intersections between H and V lines
            raw_intersections: list[list[float]] = []
            for hl in h_lines:
                for vl in v_lines:
                    pt = _line_intersection(hl, vl)
                    if pt and 0 <= pt[0] <= w and 0 <= pt[1] <= h:
                        raw_intersections.append(list(pt))

            # Cluster nearby intersections (within 20px)
            intersections = _cluster_points(raw_intersections, radius=20)

            # Take 4 extremal corners from convex hull of all intersections
            if len(intersections) >= 4:
                pts_arr = np.array(intersections, dtype=np.float32)
                hull_idx = cv2.convexHull(pts_arr, returnPoints=False)
                hull_pts = pts_arr[hull_idx.flatten()].tolist()
                if len(hull_pts) >= 4:
                    corners = _pick_4_extremal(hull_pts)
                    corners = _order_corners(corners)

    # ── Step 4: Compute perspective homography ────────────────────────────
    homography: list[list[float]] | None = None
    if len(corners) == 4:
        src_pts = np.array(corners, dtype=np.float32)
        dst_pts = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32)
        M = cv2.getPerspectiveTransform(src_pts, dst_pts)
        homography = M.tolist()

    # ── Step 5: Confidence ────────────────────────────────────────────────
    # If we found a clean quad from colour segmentation, that's high confidence.
    # If we used Hough fallback, confidence scales with intersection count.
    if len(corners) == 4 and len(intersections) <= 4:
        # Came from the colour-threshold quad path — that's reliable
        confidence = 0.85
    else:
        # Hough path: scale by how many of the ~12 expected intersections we found
        confidence = min(1.0, len(intersections) / 12.0)

    return CourtDetectionResult(
        corners=corners,
        homography=homography,
        confidence=confidence,
        intersections=intersections,
    )


def compute_drift(prev_corners: list[list[float]], curr_corners: list[list[float]]) -> float:
    """
    Compute the RMS pixel distance between corresponding corner pairs.

    Returns 0.0 if either list is empty or the lists have different lengths.
    """
    if not prev_corners or not curr_corners:
        return 0.0
    if len(prev_corners) != len(curr_corners):
        return 0.0

    total = 0.0
    for (px, py), (cx, cy) in zip(prev_corners, curr_corners):
        total += (cx - px) ** 2 + (cy - py) ** 2
    return math.sqrt(total / len(prev_corners))


def map_point_to_court(
    x: float,
    y: float,
    homography_matrix: list[list[float]],
) -> tuple[float, float]:
    """
    Apply the 3×3 perspective transform to map a source pixel to court coords.

    Returns (courtX, courtY) clamped to [-0.1, 1.1] in both axes.
    """
    H = homography_matrix
    denom = H[2][0] * x + H[2][1] * y + H[2][2]
    if abs(denom) < 1e-10:
        return (0.0, 0.0)
    cx = (H[0][0] * x + H[0][1] * y + H[0][2]) / denom
    cy = (H[1][0] * x + H[1][1] * y + H[1][2]) / denom
    cx = max(-0.1, min(1.1, cx))
    cy = max(-0.1, min(1.1, cy))
    return (cx, cy)


def point_in_court(
    x: float,
    y: float,
    corners: list[list[float]],
    margin_px: float = 30,
) -> bool:
    """
    Return True if (x, y) is inside (or within margin_px of) the court polygon.

    Uses cv2.pointPolygonTest.  Returns False if corners is empty.
    """
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    if not corners:
        return False

    pts = np.array(corners, dtype=np.float32)
    result = cv2.pointPolygonTest(pts, (float(x), float(y)), True)
    return result >= -margin_px


# ── Internal helpers ──────────────────────────────────────────────────────────

def _order_corners(pts: list) -> list[list[float]]:
    """Order 4 points as [top-left, top-right, bottom-right, bottom-left]."""
    pts_f = [[float(p[0]), float(p[1])] for p in pts]
    # Sort by y (top two / bottom two)
    sorted_by_y = sorted(pts_f, key=lambda p: p[1])
    top = sorted(sorted_by_y[:2], key=lambda p: p[0])   # TL, TR
    bottom = sorted(sorted_by_y[2:], key=lambda p: p[0], reverse=True)  # BR, BL by x desc
    # Reorder bottom to BR, BL
    bottom_sorted = sorted(sorted_by_y[2:], key=lambda p: p[0])
    return [top[0], top[1], bottom_sorted[1], bottom_sorted[0]]


def _line_intersection(l1, l2) -> tuple[float, float] | None:
    """Compute the intersection of two line segments expressed as [x1,y1,x2,y2]."""
    x1, y1, x2, y2 = l1
    x3, y3, x4, y4 = l2
    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-6:
        return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    ix = x1 + t * (x2 - x1)
    iy = y1 + t * (y2 - y1)
    return (ix, iy)


def _cluster_points(pts: list[list[float]], radius: float) -> list[list[float]]:
    """Greedy cluster: merge points within `radius` of each other by centroid."""
    if not pts:
        return []
    clusters: list[list[list[float]]] = []
    for p in pts:
        merged = False
        for cluster in clusters:
            cx = sum(c[0] for c in cluster) / len(cluster)
            cy = sum(c[1] for c in cluster) / len(cluster)
            if math.hypot(p[0] - cx, p[1] - cy) <= radius:
                cluster.append(p)
                merged = True
                break
        if not merged:
            clusters.append([p])
    return [[sum(c[0] for c in cl) / len(cl), sum(c[1] for c in cl) / len(cl)] for cl in clusters]


def _pick_4_extremal(pts: list) -> list[list[float]]:
    """
    Pick 4 representative corner points from the convex hull.

    Selects the point closest to each of the 4 image corners:
    top-left (min x+y), top-right (max x-y), bottom-right (max x+y), bottom-left (min x-y).
    """
    pts_f = [[float(p[0]), float(p[1])] for p in pts]
    tl = min(pts_f, key=lambda p: p[0] + p[1])
    tr = max(pts_f, key=lambda p: p[0] - p[1])
    br = max(pts_f, key=lambda p: p[0] + p[1])
    bl = min(pts_f, key=lambda p: p[0] - p[1])
    return [tl, tr, br, bl]
