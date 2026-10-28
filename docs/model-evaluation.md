# Model Evaluation

This document records model candidates, evaluation results, and decisions.
It is updated as models are tested.

## Hardware context

| Machine | CPU | GPU | RAM |
|---|---|---|---|
| Windows dev | Intel (UHD 630 integrated) | None | Unknown |
| Ubuntu VM (LLM) | Unknown | NVIDIA RTX 5060 Ti (16 GB VRAM) | Unknown |
| Production server | TBD | TBD | TBD |

**No GPU performance claims are made until benchmarks are run.**

---

## Player detection + pose estimation

### Selected model

| Model | License | CPU feasible? | Status |
|---|---|---|---|
| YOLO11n-pose (Ultralytics) | AGPL-3.0 | Yes (slow, ~2-5 fps) | **Selected** |

YOLO11n-pose provides detection + 17 COCO keypoints + ByteTrack tracking in a single pass.
AGPL-3.0 is acceptable for personal/non-distributed use.

### Hardware

| Machine | GPU | Driver | CUDA | Status |
|---|---|---|---|---|
| Windows dev | None (Intel UHD 630) | N/A | N/A | CPU-only (dev/testing) |
| Ubuntu VM | RTX 5060 Ti 16GB | 595.91.07 | 13.2 | **Verified** — GPU available, 0% util |

### PyTorch compatibility

RTX 5060 Ti is Blackwell (sm_120). Requires PyTorch built with CUDA 12.8+ (cu128).
- CPU build: `pip install torch --index-url https://download.pytorch.org/whl/cpu`
- GPU build: `pip install torch --index-url https://download.pytorch.org/whl/cu128`

### GPU benchmark

*Not yet performed — requires installing torch+cu128 on the Ubuntu VM.*

Before production:
1. Install `torch` cu128 + `ultralytics` + `opencv-python-headless` on the Ubuntu VM
2. Run `python -c "import torch; print(torch.cuda.is_available())"` to confirm
3. Process a 60-second clip and record: fps, VRAM usage, detection quality
4. Check if Ollama can run simultaneously without VRAM contention

---

## Shuttlecock tracking

### Candidates

| Model | License | CPU feasible? | Status |
|---|---|---|---|
| TrackNetV2 | Research (non-commercial) | Likely no | Not evaluated |
| YOLO + Kalman filter | AGPL-3.0 | To be tested | Not evaluated |

### Evaluation protocol

- Input: 30-second clip with visible shuttle
- Metric: detection precision/recall on manually annotated frames, fps
- Fallback threshold: if TrackNetV2 <0.5 fps, switch to YOLO + Kalman

### Results

*No results yet — Phase 4 not started.*

---

## LLM coaching (Phase 6+)

| Service | Model | API | Status |
|---|---|---|---|
| Ollama on Ubuntu VM | TBD | OpenAI-compatible `/v1/chat/completions` | Not configured |

**Verification required before Phase 6:**
- Confirm `LLM_ENDPOINT_URL` is reachable from the production server.
- Confirm the API endpoint and authentication method.
- Confirm the model name and context window.
- Confirm the endpoint never receives raw video data.
