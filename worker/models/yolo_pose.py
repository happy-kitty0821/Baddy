"""
YOLO11n-pose adapter using Ultralytics.

Provides detection + 17-keypoint pose estimation + ByteTrack tracking
in a single model pass.  This is the default and only adapter for Phase 2.

Heavy dependencies (torch, ultralytics, cv2) are imported lazily inside
``load()`` so that the module can be imported in test environments where
those packages are not installed.

License: AGPL-3.0 (Ultralytics).  Acceptable for personal/non-distributed use.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from worker.models.base import Detection

logger = logging.getLogger(__name__)

# Model identifier stored in the database for reproducibility.
MODEL_ID = "yolo11n-pose"


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
        results = self._model.predict(
            frame, device=self._device, verbose=False
        )
        return self._parse_results(results)

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
        """
        if self._model is None:
            raise RuntimeError("Model not loaded — call load() first.")

        # Use stream=True for memory efficiency on long videos.
        results_stream = self._model.track(
            source=str(video_path),
            tracker="bytetrack.yaml",
            conf=confidence,
            imgsz=img_size,
            device=self._device,
            stream=True,
            verbose=False,
        )

        frame_index = 0
        for result in results_stream:
            if frame_index % frame_skip == 0:
                frame = result.orig_img  # source-resolution numpy array
                detections = self._parse_results(result)
                yield (frame_index, frame, detections)
            frame_index += 1

    def _parse_results(self, result) -> list[Detection]:
        """
        Convert an Ultralytics result object to our Detection dataclass.

        Handles the case where keypoints are None (no person detected).
        """
        detections: list[Detection] = []

        boxes = result.boxes
        keypoints = result.keypoints

        if boxes is None or len(boxes) == 0:
            return detections

        for i in range(len(boxes)):
            # Bounding box: Ultralytics returns xywh in source pixels.
            xywh = boxes.xywh[i].cpu().numpy()
            conf = float(boxes.conf[i].cpu().numpy())

            # Track ID: only present when tracking (result.boxes.id is not None).
            track_id = None
            if boxes.id is not None:
                track_id = int(boxes.id[i].cpu().numpy())

            # Keypoints: Ultralytics returns shape (17, 3) — x, y, confidence.
            kp_list: list[list[float]] = []
            kp_conf = 0.0
            if keypoints is not None and keypoints.xy is not None:
                kps = keypoints.xy[i].cpu().numpy()  # (17, 2)
                kp_conf_arr = keypoints.conf[i].cpu().numpy() if keypoints.conf is not None else None
                visible_count = 0
                for j in range(kps.shape[0]):
                    c = float(kp_conf_arr[j]) if kp_conf_arr is not None else 1.0
                    kp_list.append([float(kps[j, 0]), float(kps[j, 1]), c])
                    if c > 0.3:
                        kp_conf += c
                        visible_count += 1
                if visible_count > 0:
                    kp_conf /= visible_count

            detections.append(Detection(
                bbox=(float(xywh[0]), float(xywh[1]), float(xywh[2]), float(xywh[3])),
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
        # Force garbage collection to free GPU memory.
        try:
            import torch  # noqa: PLC0415
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
