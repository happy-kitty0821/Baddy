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

## Player detection

### Candidates

| Model | License | CPU feasible? | Status |
|---|---|---|---|
| YOLOv8n | AGPL-3.0 | To be tested | Not evaluated |
| YOLOv8s | AGPL-3.0 | To be tested | Not evaluated |

### Evaluation protocol

- Input: 60-second MP4, 1920×1080, 30 fps
- Metric: frames per second on CPU, peak RAM
- Accept if: >2 fps (30× slower than real-time is acceptable for batch processing)

### Results

*No results yet — Phase 2 not started.*

---

## Pose estimation

### Candidates

| Model | License | CPU feasible? | Status |
|---|---|---|---|
| MediaPipe Pose (Lite) | Apache 2.0 | Likely yes | Not evaluated |
| MediaPipe Pose (Full) | Apache 2.0 | Likely yes | Not evaluated |
| YOLOv8n-pose | AGPL-3.0 | To be tested | Not evaluated |

### Results

*No results yet — Phase 2 not started.*

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
