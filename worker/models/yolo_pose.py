"""
YOLO11n-pose adapter using Ultralytics.

Provides detection + 17-keypoint pose estimation + ByteTrack tracking
in a single model pass.  This is the default and only adapter for Phase 2.

Heavy dependencies (torch, ultralytics, cv2) are imported lazily inside
``load()`` so that the module can be imported in test environments where
those packages are not installed.

License: AGPL-3.0 (Ultralytics).  Acceptable for personal/non-distributed use.

False-positive filtering
─────────────────────────
After YOLO returns detections we apply four lightweight post-filters before
yielding a Detection:

  1. Min bbox area  — a legitimate player covers at least 0.5 % of the frame
     area.  Tiny blobs (reflections, distant spectators) are discarded.

  2. Aspect-ratio plausibility — a standing or crouching badminton player has
     h/w between 1.2 and 5.0 (taller than wide).  Wide blobs are usually
     crowd rows or cameramen.

  3. Min visible keypoints — at least 5 COCO keypoints must have confidence
     > KEYPOINT_VIS_THRESHOLD.  Ghost detections on the edge of the frame
     typically have 0–2 visible keypoints.

  4. Court-edge exclusion — detections whose bbox centre is within EDGE_MARGIN
     (4 %) of any frame edge are almost never the main court players.

Vertical / portrait video support
───────────────────────────────────
When the source frame is portrait (height > width), the YOLO imgsz is passed
as a (height, width) tuple matched to the source aspect ratio so the model
sees the full player height instead of a heavily downscaled short axis.
Standard landscape footage still uses the scalar img_size from settings.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from worker.models.base import Detection

logger = logging.getLogger(__name__)

# Model identifier stored in the database for reproducibility.
MODEL_ID = "yolo11n-pose"

# ── Post-detection filter constants ──────────────────────────────────────────

# Minimum bbox area as a fraction of total frame area.
# 0.005 = 0.5 % — rejects very small distant detections.
MIN_BBOX_AREA_FRACTION = 0.005

# Acceptable h/w aspect ratio range for a person standing or crouching.
# h/w < 1.2 → too wide (crowd row, false positive).
# h/w > 6.0 → too narrow (partial body on frame edge).
MIN_ASPECT_RATIO = 1.2
MAX_ASPECT_RATIO = 6.0

# Minimum number of COCO keypoints with confidence > this threshold.
KEYPOINT_VIS_THRESHOLD = 0.25
MIN_VISIBLE_KEYPOINTS = 5

# Fraction of frame dimension — detections centred this close to any edge
# are rejected as out-of-court.
EDGE_MARGIN = 0.04

# Portrait imgsz: keep the long axis at 960 for better quality on tall frames.
# Ultralytics accepts (height, width) tuples.
PORTRAIT_IMGSZ_LONG = 960


class YoloPoseAdapter:
    """Wraps Ultralytics YOLO11n-pose for detection + pose + tracking."""

    def __init__(self, weights_dir: str = "") -> None:
        self._model = None
        self._device = "cpu"
        self._weights_dir = weights_dir

    def load(self, device: str) -> None:
        """Load the YOLO11n-pose model weights onto *device*."""
        import torch  # noqa: PLC0415 — lazy import
        from ultralytics import YOLO  # noqa: PLC0415

        # Resolve model weights path.
        model_name = "yolo11n-pose.pt"
        if self._weights_dir:
            weights_path = str(Path(self._weights_dir) / model_name)
        else:
            weights_path = model_name  # Ultralytics auto-downloads to cache

        logger.info("Loading YOLO11n-pose from %s on device %s", weights_path, device)
        self._model = YOLO(weights_path)
        self._device = device

        # Warm up the model with a dummy frame to catch CUDA errors early.
        dummy = np.zeros((640, 640, 3), dtype=np.uint8)
        self._model.predict(dummy, device=device, verbose=False)
        logger.info("Model loaded and warmed up successfully.")

    def infer_frame(self, frame: np.ndarray) -> list[Detection]:
        """Run detection + pose on a single frame (no tracking)."""
        if self._model is None:
            raise RuntimeError("Model not loaded — call load() first.")
        h, w = frame.shape[:2]
        imgsz = _portrait_imgsz(h, w)
        results = self._model.predict(
            frame, device=self._device, imgsz=imgsz, verbose=False,
        )
        return self._parse_results(results, frame_w=w, frame_h=h)

    def infer_video(
        self,
        video_path: str,
        frame_skip: int,
        confidence: float,
        img_size: int,
    ) -> list[tuple[int, np.ndarray, list[Detection]]]:
        """
        Run detection + tracking + pose across an entire video.

        Uses Ultralytics' built-in ByteTrack tracker (mode='track').
        Yields (frame_index, frame, [Detection, ...]) for every *frame_skip*-th
        frame.

        For portrait videos (height > width) the imgsz is automatically
        adjusted to a (height, width) tuple so the full player height is
        preserved at the model's native resolution.
        """
        if self._model is None:
            raise RuntimeError("Model not loaded — call load() first.")

        # Peek at the first frame to determine orientation.
        import cv2  # noqa: PLC0415
        cap = cv2.VideoCapture(str(video_path))
        frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cap.release()

        imgsz = _portrait_imgsz(frame_h, frame_w, landscape_size=img_size)
        logger.info(
            "Vision imgsz=%s for source %dx%d (%s)",
            imgsz, frame_w, frame_h,
            "portrait" if frame_h > frame_w else "landscape",
        )

        # Use stream=True for memory efficiency on long videos.
        results_stream = self._model.track(
            source=str(video_path),
            tracker="bytetrack.yaml",
            conf=confidence,
            imgsz=imgsz,
            device=self._device,
            stream=True,
            verbose=False,
        )

        frame_index = 0
        for result in results_stream:
            if frame_index % frame_skip == 0:
                frame = result.orig_img  # source-resolution numpy array
                detections = self._parse_results(
                    result, frame_w=frame_w, frame_h=frame_h,
                )
                yield (frame_index, frame, detections)
            frame_index += 1

    def _parse_results(
        self,
        result,
        frame_w: int = 0,
        frame_h: int = 0,
    ) -> list[Detection]:
        """
        Convert an Ultralytics result object to our Detection dataclass,
        applying false-positive filters.

        Parameters
        ----------
        result    : Ultralytics Results object (from predict / track).
        frame_w   : Source frame width in pixels (used for area/edge checks).
        frame_h   : Source frame height in pixels.
        """
        detections: list[Detection] = []

        boxes = result.boxes
        keypoints = result.keypoints

        if boxes is None or len(boxes) == 0:
            return detections

        frame_area = frame_w * frame_h if (frame_w > 0 and frame_h > 0) else 0

        for i in range(len(boxes)):
            # ── Bounding box: Ultralytics xywh returns (cx, cy, w, h) ──────
            xywh = boxes.xywh[i].cpu().numpy()
            cx, cy, bw, bh = (
                float(xywh[0]), float(xywh[1]),
                float(xywh[2]), float(xywh[3]),
            )
            conf = float(boxes.conf[i].cpu().numpy())

            # ── Track ID ─────────────────────────────────────────────────────
            track_id = None
            if boxes.id is not None:
                track_id = int(boxes.id[i].cpu().numpy())

            # ── Keypoints ────────────────────────────────────────────────────
            kp_list: list[list[float]] = []
            kp_conf = 0.0
            visible_count = 0
            if keypoints is not None and keypoints.xy is not None:
                kps = keypoints.xy[i].cpu().numpy()  # (17, 2)
                kp_conf_arr = (
                    keypoints.conf[i].cpu().numpy()
                    if keypoints.conf is not None
                    else None
                )
                for j in range(kps.shape[0]):
                    c = float(kp_conf_arr[j]) if kp_conf_arr is not None else 1.0
                    kp_list.append([float(kps[j, 0]), float(kps[j, 1]), c])
                    if c > KEYPOINT_VIS_THRESHOLD:
                        kp_conf += c
                        visible_count += 1
                if visible_count > 0:
                    kp_conf /= visible_count

            # ── False-positive filters ────────────────────────────────────────
            if frame_area > 0:
                bbox_area = bw * bh

                # 1. Minimum bbox area — reject tiny distant detections.
                if bbox_area < frame_area * MIN_BBOX_AREA_FRACTION:
                    logger.debug(
                        "Rejected detection: area %.0f < min %.0f (frame %dx%d)",
                        bbox_area, frame_area * MIN_BBOX_AREA_FRACTION,
                        frame_w, frame_h,
                    )
                    continue

                # 2. Aspect-ratio plausibility — person is taller than wide.
                if bw > 0:
                    aspect = bh / bw
                    if not (MIN_ASPECT_RATIO <= aspect <= MAX_ASPECT_RATIO):
                        logger.debug(
                            "Rejected detection: aspect %.2f outside [%.1f, %.1f]",
                            aspect, MIN_ASPECT_RATIO, MAX_ASPECT_RATIO,
                        )
                        continue

                # 3. Court-edge exclusion — skip detections on the frame border.
                margin_x = frame_w * EDGE_MARGIN
                margin_y = frame_h * EDGE_MARGIN
                if (cx < margin_x or cx > frame_w - margin_x or
                        cy < margin_y or cy > frame_h - margin_y):
                    logger.debug(
                        "Rejected detection: centre (%.0f, %.0f) within edge margin",
                        cx, cy,
                    )
                    continue

            # 4. Minimum visible keypoints — reject ghost/partial detections.
            if visible_count < MIN_VISIBLE_KEYPOINTS:
                logger.debug(
                    "Rejected detection: only %d visible keypoints (need %d)",
                    visible_count, MIN_VISIBLE_KEYPOINTS,
                )
                continue

            detections.append(Detection(
                bbox=(cx, cy, bw, bh),
                bbox_conf=conf,
                track_id=track_id,
                keypoints=kp_list,
                keypoint_conf=kp_conf,
                model_id=MODEL_ID,
            ))

        return detections

    def unload(self) -> None:
        """Release model resources."""
        if self._model is not None:
            del self._model
            self._model = None
        try:
            import torch  # noqa: PLC0415
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass


# ── Helpers ───────────────────────────────────────────────────────────────────

def _portrait_imgsz(
    frame_h: int,
    frame_w: int,
    landscape_size: int = 640,
) -> int | tuple[int, int]:
    """
    Return the appropriate imgsz for YOLO given the source frame dimensions.

    Landscape (width >= height):
        Return scalar *landscape_size* (e.g. 640) — standard square inference.

    Portrait (height > width):
        Return (long_side, short_side) tuple so YOLO preserves the full
        player height.  Long side is capped at PORTRAIT_IMGSZ_LONG (960) and
        both dimensions are rounded to the nearest 32 (YOLO stride requirement).

        Example: 608×1080 portrait → long_side=960, short_side=round(960*(608/1080)/32)*32=544
                 → imgsz=(960, 544).
    """
    if frame_h <= frame_w or frame_h == 0 or frame_w == 0:
        # Landscape or square — use scalar.
        return landscape_size

    # Portrait — compute aspect-preserving (H, W) tuple.
    long_side = PORTRAIT_IMGSZ_LONG
    ar = frame_w / frame_h
    short_side = int(round(long_side * ar / 32) * 32)
    short_side = max(short_side, 32)  # never less than one stride
    return (long_side, short_side)
