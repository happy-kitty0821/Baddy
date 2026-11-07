"""
System information endpoint.

GET /api/system — returns hardware specs, GPU info, Python env, and
                   capability flags for the frontend profile page.

All data is read-only and non-sensitive: hardware specs, driver versions,
and which optional features are available.  No secrets are exposed.
"""

from __future__ import annotations

import logging
import os
import platform
import sys
from pathlib import Path

from fastapi import APIRouter

from app.dependencies import CurrentUser

router = APIRouter(prefix="/api", tags=["system"])

logger = logging.getLogger(__name__)


def _safe(fn):
    """Call fn(), return None on any exception."""
    try:
        return fn()
    except Exception:
        return None


def _cpu_info() -> dict:
    """Collect CPU name, core counts, and current frequency."""
    info: dict = {}
    try:
        import psutil
        info["physical_cores"] = psutil.cpu_count(logical=False)
        info["logical_cores"]  = psutil.cpu_count(logical=True)
        freq = psutil.cpu_freq()
        if freq:
            info["freq_mhz_current"] = round(freq.current, 1)
            info["freq_mhz_max"]     = round(freq.max, 1)
        info["usage_pct"] = psutil.cpu_percent(interval=0.1)
    except ImportError:
        info["physical_cores"] = os.cpu_count()
        info["logical_cores"]  = os.cpu_count()

    # Try to get the CPU model name.
    name: str | None = None
    if platform.system() == "Windows":
        try:
            import subprocess
            out = subprocess.check_output(
                ["wmic", "cpu", "get", "Name"], text=True, timeout=5
            ).strip().splitlines()
            name = next((l.strip() for l in out if l.strip() and l.strip() != "Name"), None)
        except Exception:
            pass
    elif platform.system() == "Linux":
        try:
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if "model name" in line:
                        name = line.split(":")[1].strip()
                        break
        except Exception:
            pass
    elif platform.system() == "Darwin":
        name = _safe(lambda: __import__("subprocess").check_output(
            ["sysctl", "-n", "machdep.cpu.brand_string"], text=True
        ).strip())

    info["name"] = name or platform.processor() or "Unknown"
    return info


def _ram_info() -> dict:
    """Total, available, and used RAM."""
    try:
        import psutil
        vm = psutil.virtual_memory()
        return {
            "total_gb":     round(vm.total     / 1e9, 2),
            "available_gb": round(vm.available / 1e9, 2),
            "used_gb":      round(vm.used      / 1e9, 2),
            "usage_pct":    vm.percent,
        }
    except ImportError:
        return {}


def _disk_info() -> dict:
    """Disk usage for the project storage root."""
    try:
        import psutil
        from app.config import settings
        path = str(settings.storage_path)
        usage = psutil.disk_usage(path)
        return {
            "path":       path,
            "total_gb":   round(usage.total / 1e9, 2),
            "used_gb":    round(usage.used  / 1e9, 2),
            "free_gb":    round(usage.free  / 1e9, 2),
            "usage_pct":  usage.percent,
        }
    except Exception:
        return {}


def _gpu_info() -> list[dict]:
    """GPU info via torch.cuda and pynvml/nvidia-smi."""
    gpus: list[dict] = []

    # Try torch first.
    try:
        import torch
        if not torch.cuda.is_available():
            return [{"available": False, "reason": "CUDA not available"}]

        device_count = torch.cuda.device_count()
        for i in range(device_count):
            props = torch.cuda.get_device_properties(i)
            gpu: dict = {
                "index":          i,
                "name":           props.name,
                "vram_total_gb":  round(props.total_memory / 1e9, 2),
                "cuda_capability": f"{props.major}.{props.minor}",
                "sm_count":       props.multi_processor_count,
                "available":      True,
            }
            # Current memory usage.
            try:
                mem = torch.cuda.memory_stats(i)
                reserved  = mem.get("reserved_bytes.all.current", 0)
                allocated = mem.get("allocated_bytes.all.current", 0)
                gpu["vram_reserved_gb"]  = round(reserved  / 1e9, 3)
                gpu["vram_allocated_gb"] = round(allocated / 1e9, 3)
                gpu["vram_free_gb"] = round(
                    (props.total_memory - reserved) / 1e9, 3
                )
            except Exception:
                pass

            # Driver / CUDA version from torch.
            try:
                gpu["cuda_version"]  = torch.version.cuda
                gpu["torch_version"] = torch.__version__
            except Exception:
                pass

            # Current utilisation via pynvml if available.
            try:
                import pynvml  # noqa: PLC0415
                pynvml.nvmlInit()
                handle = pynvml.nvmlDeviceGetHandleByIndex(i)
                util   = pynvml.nvmlDeviceGetUtilizationRates(handle)
                temp   = pynvml.nvmlDeviceGetTemperature(
                    handle, pynvml.NVML_TEMPERATURE_GPU
                )
                gpu["util_gpu_pct"]  = util.gpu
                gpu["util_mem_pct"]  = util.memory
                gpu["temp_celsius"]  = temp
            except Exception:
                pass

            gpus.append(gpu)

        return gpus if gpus else [{"available": False, "reason": "No CUDA devices found"}]

    except ImportError:
        return [{"available": False, "reason": "PyTorch not installed"}]


def _python_info() -> dict:
    return {
        "version":     platform.python_version(),
        "implementation": platform.python_implementation(),
        "executable":  sys.executable,
    }


def _model_info() -> dict:
    """Which AI models are available (weights on disk)."""
    from app.config import settings

    weights_dir = Path(settings.model_weights_dir) if settings.model_weights_dir else (
        Path(__file__).resolve().parents[4] / "model_weights"
    )

    def has_weights(filename: str) -> bool:
        return (weights_dir / filename).exists()

    return {
        "yolo_pose": {
            "name":       "YOLO11n-Pose",
            "task":       "Player detection + pose estimation",
            "available":  True,   # auto-downloaded by Ultralytics on first use
            "weights_cached": _safe(lambda: (
                Path.home() / ".cache" / "ultralytics"
            ).exists()),
        },
        "tracknet_v2": {
            "name":       "TrackNet V2",
            "task":       "Shuttlecock tracking",
            "available":  has_weights("tracknet_v2_best.pt"),
            "weights_path": str(weights_dir / "tracknet_v2_best.pt")
                            if has_weights("tracknet_v2_best.pt") else None,
        },
    }


def _capability_flags() -> dict:
    """High-level feature readiness flags shown in the UI."""
    from app.config import settings

    gpu_ok   = False
    try:
        import torch
        gpu_ok = torch.cuda.is_available()
    except ImportError:
        pass

    weights_dir = Path(settings.model_weights_dir) if settings.model_weights_dir else (
        Path(__file__).resolve().parents[4] / "model_weights"
    )
    shuttle_ok = (weights_dir / "tracknet_v2_best.pt").exists()

    return {
        "player_detection":    True,          # always available (YOLO auto-downloads)
        "pose_estimation":     True,
        "skeleton_overlay":    True,
        "court_heatmap":       True,
        "shuttle_tracking":    shuttle_ok,
        "gpu_inference":       gpu_ok,
        "court_calibration":   settings.court_calibration_enabled,
        "coaching_llm":        bool(settings.llm_endpoint_url),
    }


@router.get("/system")
def get_system_info(current_user: CurrentUser) -> dict:
    """Return hardware specs, GPU info, model availability, and capability flags."""
    from app.config import settings

    return {
        "platform": {
            "os":           platform.system(),
            "os_version":   platform.version(),
            "os_release":   platform.release(),
            "machine":      platform.machine(),
            "hostname":     platform.node(),
        },
        "cpu":          _cpu_info(),
        "ram":          _ram_info(),
        "disk":         _disk_info(),
        "gpus":         _gpu_info(),
        "python":       _python_info(),
        "models":       _model_info(),
        "capabilities": _capability_flags(),
        "config": {
            "inference_device":            settings.inference_device,
            "vision_target_fps":           settings.vision_target_fps,
            "vision_confidence":           settings.vision_confidence,
            "vision_img_size":             settings.vision_img_size,
            "vision_max_players":          settings.vision_max_players,
            "vision_min_track_frames":     settings.vision_min_track_frames,
            "shuttle_tracking_enabled":    settings.shuttle_tracking_enabled,
            "court_calibration_enabled":   settings.court_calibration_enabled,
            "max_upload_mb":               settings.max_upload_mb,
            "max_duration_minutes":        settings.max_duration_minutes,
        },
    }
