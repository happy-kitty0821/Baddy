"""
Model adapter protocol for the vision pipeline.

All model inference goes through this interface so the worker can swap
YOLO for another detector/pose model without changing the pipeline code.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import numpy as np


@dataclass
class Detection:
    """A single detection result from one frame."""
    bbox: tuple[float, float, float, float]  # x, y, w, h in source pixels
    bbox_conf: float
    track_id: int | None  # assigned by tracker; None if not yet tracked
    keypoints: list[list[float]]  # [[x, y, conf], ...] — 17 COCO points, source pixels
    keypoint_conf: float  # overall keypoint confidence (mean of visible)
    model_id: str


@runtime_checkable
class ModelAdapter(Protocol):
    """Minimal protocol required by the vision pipeline."""

    def load(self, device: str) -> None:
        """Load model weights onto the specified device (cpu or cuda:0)."""
        ...

    def infer_frame(self, frame: np.ndarray) -> list[Detection]:
        """Run detection + pose on a single frame. Returns 0+ detections."""
        ...

    def infer_video(
        self,
        video_path: str,
        frame_skip: int,
        confidence: float,
        img_size: int,
    ) -> list[tuple[int, np.ndarray, list[Detection]]]:
        """
        Run detection + tracking across an entire video.

        Yields (frame_index, frame_np, [Detection, ...]) tuples.
        The implementation handles its own tracking (e.g. ByteTrack).
        """
        ...

    def unload(self) -> None:
        """Release model resources."""
        ...
