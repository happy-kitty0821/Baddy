"""
TrackNet V2 adapter for shuttlecock detection.

Self-contained: implements the TrackNetV2 nn.Module from scratch and an
adapter class with load / infer_video / unload lifecycle.

Heavy dependencies (torch, cv2, numpy) are imported LAZILY inside
load() / infer_video() so this module is importable in environments
without those packages installed (e.g. unit-test environments with mocks).

Network architecture (input: B×9×288×512):
  Encoder:
    enc1: 9→64,  2 convs → MaxPool2d(2)
    enc2: 64→128, 2 convs → MaxPool2d(2)
    enc3: 128→256, 3 convs → MaxPool2d(2)
    enc4: 256→512, 3 convs → Dropout2d (bottleneck)
  Decoder (upsample + skip concat):
    dec1: 768→256, 3 convs  (512 up + 256 skip)
    dec2: 384→128, 2 convs  (256 up + 128 skip)
    dec3: 192→64,  2 convs  (128 up + 64  skip)
  Head: 64→3, 1×1 conv → logits
"""

from __future__ import annotations

import logging
import os
from collections import deque
from pathlib import Path
from typing import Generator, Optional

logger = logging.getLogger(__name__)

# ── Module-level constants (update URL/filename if the release changes) ────────
MODEL_ID = "tracknet_v2"
TRACKNET_V2_WEIGHTS_FILENAME = "tracknet_v2_best.pt"
TRACKNET_V2_WEIGHTS_URL = (
    "https://github.com/AnInsomniacy/tracknet-series-pytorch"
    "/releases/download/model-v2.0.0/tracknet_v2_best.pt"
)
# TODO: set TRACKNET_V2_SHA256 once the hash is known (one-line change to verify).
TRACKNET_V2_SHA256: Optional[str] = None

# Input dimensions expected by the model.
_MODEL_W = 512
_MODEL_H = 288


# ── Pure-Python nn.Module (no lazy import needed — torch imported in load()) ──

def _make_conv_block(in_ch: int, out_ch: int) -> "torch.nn.Sequential":  # type: ignore[name-defined]
    """Conv2d(3×3,pad=1,bias=False) → BatchNorm2d → ReLU(inplace=True)."""
    import torch.nn as nn  # noqa: PLC0415
    return nn.Sequential(
        nn.Conv2d(in_ch, out_ch, kernel_size=3, padding=1, bias=False),
        nn.BatchNorm2d(out_ch),
        nn.ReLU(inplace=True),
    )


def _make_enc_block(in_ch: int, out_ch: int, n_convs: int) -> "torch.nn.Sequential":  # type: ignore[name-defined]
    import torch.nn as nn  # noqa: PLC0415
    layers = []
    ch = in_ch
    for _ in range(n_convs):
        layers.append(_make_conv_block(ch, out_ch))
        ch = out_ch
    return nn.Sequential(*layers)


def _make_dec_block(in_ch: int, out_ch: int, n_convs: int) -> "torch.nn.Sequential":  # type: ignore[name-defined]
    import torch.nn as nn  # noqa: PLC0415
    layers = []
    ch = in_ch
    for _ in range(n_convs):
        layers.append(_make_conv_block(ch, out_ch))
        ch = out_ch
    return nn.Sequential(*layers)


class TrackNetV2(object):
    """
    Lazy-constructed wrapper: the actual nn.Module is built inside load()
    so this class is importable without torch.

    Call build(torch_module_class) once torch is available.
    """


def _build_tracknet_v2_module():
    """Build and return the TrackNetV2 nn.Module using torch (called lazily)."""
    import torch  # noqa: PLC0415
    import torch.nn as nn  # noqa: PLC0415
    import torch.nn.functional as F  # noqa: PLC0415

    class _TrackNetV2(nn.Module):
        """
        TrackNet V2 U-Net.  Input: (B, 9, 288, 512) — 3 consecutive RGB frames
        each stacked along the channel axis.  Output: (B, 3, 288, 512) heatmaps
        in [0, 1] after sigmoid.  forward_logits returns the raw logits.
        """

        def __init__(self) -> None:
            super().__init__()
            # Encoder
            self.enc1 = _make_enc_block(9, 64, 2)        # → (B,64,288,512)
            self.enc2 = _make_enc_block(64, 128, 2)      # → (B,128,144,256)
            self.enc3 = _make_enc_block(128, 256, 3)     # → (B,256,72,128)
            self.enc4 = _make_enc_block(256, 512, 3)     # → (B,512,36,64) bottleneck
            self.pool = nn.MaxPool2d(2)
            self.dropout = nn.Dropout2d(p=0.5)
            # Decoder
            self.dec1 = _make_dec_block(768, 256, 3)     # 512+256=768
            self.dec2 = _make_dec_block(384, 128, 2)     # 256+128=384
            self.dec3 = _make_dec_block(192, 64, 2)      # 128+64=192
            # Head
            self.head = nn.Conv2d(64, 3, kernel_size=1)

        def forward_logits(self, x: torch.Tensor) -> torch.Tensor:
            # Encoder
            e1 = self.enc1(x)                          # (B,64,288,512)
            e2 = self.enc2(self.pool(e1))              # (B,128,144,256)
            e3 = self.enc3(self.pool(e2))              # (B,256,72,128)
            e4 = self.enc4(self.pool(e3))              # (B,512,36,64)
            b = self.dropout(e4)                       # bottleneck

            # Decoder
            d1 = F.interpolate(b, scale_factor=2, mode="nearest")   # (B,512,72,128)
            d1 = self.dec1(torch.cat([d1, e3], dim=1))              # (B,256,72,128)

            d2 = F.interpolate(d1, scale_factor=2, mode="nearest")  # (B,256,144,256)
            d2 = self.dec2(torch.cat([d2, e2], dim=1))              # (B,128,144,256)

            d3 = F.interpolate(d2, scale_factor=2, mode="nearest")  # (B,128,288,512)
            d3 = self.dec3(torch.cat([d3, e1], dim=1))              # (B,64,288,512)

            return self.head(d3)                                     # (B,3,288,512)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            return torch.sigmoid(self.forward_logits(x))

    return _TrackNetV2()


def _remap_state_dict(state_dict: dict, model_keys: list) -> dict:
    """
    Attempt to remap state_dict keys from the reference checkpoint to our
    module's key names.

    The reference repo uses the same submodule naming (enc1, enc2 …) but may
    wrap layers differently.  This helper does a best-effort prefix-based remap
    and logs any keys that couldn't be matched.
    """
    # If keys already match, return as-is.
    ck_set = set(state_dict.keys())
    mk_set = set(model_keys)
    if ck_set == mk_set:
        return state_dict

    # Build a mapping: strip common wrapper prefixes like "model.", "backbone.".
    remapped = {}
    unmatched_ck = []
    for ck, v in state_dict.items():
        mk = ck
        for prefix in ("model.", "backbone.", "network."):
            if ck.startswith(prefix):
                mk = ck[len(prefix):]
                break
        if mk in mk_set:
            remapped[mk] = v
        else:
            unmatched_ck.append(ck)

    # Add any checkpoint keys that directly match model keys (already correctly named)
    for ck, v in state_dict.items():
        if ck in mk_set and ck not in remapped:
            remapped[ck] = v

    if unmatched_ck:
        logger.warning(
            "TrackNetV2 state_dict remap: %d checkpoint keys could not be matched "
            "to model parameters. Unmatched (first 20): %s",
            len(unmatched_ck),
            unmatched_ck[:20],
        )
    missing = mk_set - set(remapped.keys())
    if missing:
        logger.warning(
            "TrackNetV2 state_dict remap: %d model keys have no matching checkpoint "
            "key. Missing (first 20): %s",
            len(missing),
            list(missing)[:20],
        )
    return remapped


class TrackNetV2Adapter:
    """
    Lifecycle adapter for TrackNet V2 shuttlecock detection.

    Usage:
        adapter = TrackNetV2Adapter(weights_dir="/path/to/weights")
        adapter.load(device)
        for frame_index, frame, ts, x, y, conf in adapter.infer_video(...):
            ...
        adapter.unload()
    """

    def __init__(self, weights_dir: str = "") -> None:
        self._weights_dir = weights_dir
        self._model = None
        self._device: str = "cpu"

    # ── Weights path resolution ────────────────────────────────────────────

    def _resolve_weights_path(self) -> Path:
        """Resolve the path to the weights file, creating the dir if needed."""
        if self._weights_dir:
            d = Path(self._weights_dir)
        else:
            # Fall back to a project-local model_weights/ dir.
            d = Path(__file__).resolve().parents[2] / "model_weights"
        d.mkdir(parents=True, exist_ok=True)
        return d / TRACKNET_V2_WEIGHTS_FILENAME

    # ── Download ───────────────────────────────────────────────────────────

    def _download_weights(self, dest: Path) -> None:
        """Download weights to dest using a .tmp file to avoid partial writes."""
        import urllib.request  # noqa: PLC0415
        tmp = dest.with_suffix(".pt.tmp")
        logger.info("Downloading TrackNet V2 weights from %s …", TRACKNET_V2_WEIGHTS_URL)
        try:
            urllib.request.urlretrieve(TRACKNET_V2_WEIGHTS_URL, str(tmp))
            os.replace(tmp, dest)
            logger.info(
                "TrackNet V2 weights saved to %s (%.1f MB)",
                dest, dest.stat().st_size / 1e6,
            )
        except Exception:
            if tmp.exists():
                try:
                    tmp.unlink()
                except Exception:
                    pass
            raise RuntimeError(
                f"Failed to download TrackNet V2 weights from {TRACKNET_V2_WEIGHTS_URL}. "
                "Check network connectivity and try again."
            )

    # ── Load ───────────────────────────────────────────────────────────────

    def load(self, device: str) -> None:
        """Build model, load weights (downloading if needed), warm up."""
        import torch  # noqa: PLC0415

        self._device = device
        weights_path = self._resolve_weights_path()

        if not weights_path.exists():
            self._download_weights(weights_path)

        model = _build_tracknet_v2_module()

        # Load state dict with fallback remap.
        raw = torch.load(str(weights_path), map_location="cpu")
        # Unwrap common checkpoint wrappers.
        if isinstance(raw, dict):
            if "model_state_dict" in raw:
                # Reference repo wraps the state dict under 'model_state_dict'
                state_dict = raw["model_state_dict"]
            elif "state_dict" in raw:
                state_dict = raw["state_dict"]
            elif "model" in raw:
                state_dict = raw["model"]
            else:
                state_dict = raw
        else:
            state_dict = raw

        model_keys = list(model.state_dict().keys())

        try:
            model.load_state_dict(state_dict, strict=True)
            logger.info(
                "TrackNetV2: weights loaded (strict). Keys: %d. First key: %s",
                len(state_dict), next(iter(state_dict), "none"),
            )
        except RuntimeError as exc:
            logger.warning(
                "TrackNetV2 strict load failed: %s\n"
                "Attempting key remap …\n"
                "Checkpoint keys (first 40): %s",
                str(exc)[:300],
                list(state_dict.keys())[:40],
            )
            remapped = _remap_state_dict(state_dict, model_keys)
            model.load_state_dict(remapped, strict=False)
            unexpected = set(remapped.keys()) - set(model_keys)
            if unexpected:
                logger.warning(
                    "TrackNetV2 remapped load: %d unexpected keys remain: %s",
                    len(unexpected), list(unexpected)[:20],
                )
            else:
                logger.info("TrackNetV2: weights loaded via key remap (zero unexpected keys).")

        model.to(device)
        model.eval()

        # Warmup with a dummy tensor to catch shape/CUDA errors early.
        with torch.no_grad():
            dummy = torch.zeros(1, 9, _MODEL_H, _MODEL_W, device=device)
            _ = model(dummy)
        logger.info("TrackNetV2: warmup complete on device=%s", device)

        self._model = model

    # ── Inference generator ────────────────────────────────────────────────

    def infer_video(
        self,
        video_path: str,
        frame_skip: int,  # accepted for signature parity but IGNORED (every frame needed)
        confidence_threshold: float,
        device: str,
    ) -> Generator[tuple[int, object, int, Optional[float], Optional[float], Optional[float]], None, None]:
        """
        Generator yielding (frame_index, frame, timestamp_ms, x, y, confidence)
        for every frame in the video.

        frame_skip is ignored — the 3-frame window requires consecutive frames.
        x/y/confidence are None when observation_status would be "unavailable".
        """
        import cv2  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415
        import torch  # noqa: PLC0415

        model = self._model
        if model is None:
            raise RuntimeError("TrackNetV2Adapter.load() must be called before infer_video().")

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            logger.warning("TrackNetV2: could not open video %s", video_path)
            return

        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        # Rolling deque of the last 3 preprocessed RGB frames (model resolution).
        window: deque = deque(maxlen=3)
        frame_index = 0

        try:
            while True:
                ret, bgr_frame = cap.read()
                if not ret:
                    break

                # Preprocess: resize → RGB → float32 /255 → CHW
                resized = cv2.resize(bgr_frame, (_MODEL_W, _MODEL_H))
                rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
                arr = rgb.astype(np.float32) / 255.0   # (288, 512, 3)
                chw = arr.transpose(2, 0, 1)            # (3, 288, 512)

                window.append(chw)

                # Pad to 3 by repeating earliest available frame at front.
                frames_in_window = list(window)
                while len(frames_in_window) < 3:
                    frames_in_window.insert(0, frames_in_window[0])

                # Stack to (9, 288, 512) → (1, 9, 288, 512)
                stacked = np.concatenate(frames_in_window, axis=0)  # (9,288,512)
                tensor = torch.from_numpy(stacked).unsqueeze(0).to(device)  # (1,9,288,512)

                timestamp_ms = int((frame_index / fps) * 1000)

                with torch.no_grad():
                    output = model(tensor)   # (1, 3, 288, 512)

                # Take the last (3rd) heatmap as the prediction for this frame.
                heatmap_t = output[0, 2].cpu().numpy()   # (288, 512)

                x, y, conf = self._decode_heatmap(heatmap_t, confidence_threshold, src_w, src_h)

                yield (frame_index, bgr_frame, timestamp_ms, x, y, conf)
                frame_index += 1

        finally:
            cap.release()

    # ── Heatmap decoding ───────────────────────────────────────────────────

    @staticmethod
    def _decode_heatmap(
        heatmap: "np.ndarray",  # type: ignore[name-defined]
        confidence_threshold: float,
        src_w: int,
        src_h: int,
    ) -> tuple[Optional[float], Optional[float], Optional[float]]:
        """
        Decode a single (288, 512) heatmap into source-resolution coordinates.

        Returns (x, y, confidence) in source pixels, or (None, None, None) when
        no shuttle is detected.
        """
        import cv2  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415

        binary = (heatmap >= confidence_threshold).astype(np.uint8)

        if binary.sum() == 0:
            return None, None, None

        n_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(
            binary, connectivity=8
        )

        if n_labels < 2:
            # Only background label 0
            return None, None, None

        # Find the largest non-background blob (label 0 is background).
        best_label = -1
        best_area = 0
        for label in range(1, n_labels):
            area = stats[label, cv2.CC_STAT_AREA]
            if area > best_area:
                best_area = area
                best_label = label

        # Discard single-pixel speckle noise.
        if best_area < 3:
            return None, None, None

        cx, cy = centroids[best_label]
        blob_mask = (labels == best_label)
        conf = float(heatmap[blob_mask].max())

        # Scale from model resolution back to source resolution.
        x = cx * (src_w / float(_MODEL_W))
        y = cy * (src_h / float(_MODEL_H))

        return float(x), float(y), conf

    # ── Unload ─────────────────────────────────────────────────────────────

    def unload(self) -> None:
        """Release the model and free GPU memory if applicable."""
        try:
            import torch  # noqa: PLC0415
            if self._model is not None:
                del self._model
                self._model = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            self._model = None
