from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / ".tmp" / "gui-e2e"
RUNTIME_ROOT = ROOT / ".tmp" / "runtime-check"
STIMULUS_NAME = "stimulus_accuracy"
STIMULUS_INPUT = FIXTURE_DIR / f"{STIMULUS_NAME}.wav"
STIMULUS_METADATA = FIXTURE_DIR / f"{STIMULUS_NAME}.json"
STIMULUS_NOTATION = ROOT / "e2e" / "fixtures" / "stimulus-accuracy.pvabc"
DEFAULT_EXTERNAL_CLIP = FIXTURE_DIR / "external_clip.mp4"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark deterministic preprocessing on the tracked PitchView CUDA path.")
    parser.add_argument("--external-source", type=Path, help="Optional source media to trim into a reproducible 10 second external clip for the real-world benchmark.")
    parser.add_argument("--external-seconds", type=float, default=10.0, help="Length of the external benchmark clip when trimming from --external-source.")
    parser.add_argument("--write-baseline", type=Path, help="Optional path to write the benchmark summary JSON for check-in.")
    return parser.parse_args()


def load_preprocess_module():
    script = ROOT / "tools" / "preprocess_media.py"
    spec = importlib.util.spec_from_file_location("pitchview_preprocess_media_runtime", script)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load tools/preprocess_media.py")

    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def make_repo_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def run_command(command: list[str]) -> None:
    subprocess.run(command, check=True, cwd=ROOT)


def ensure_stimulus_fixture() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    run_command([
        sys.executable,
        str(ROOT / "tools" / "generate_stimulus_fixture.py"),
        str(FIXTURE_DIR),
        STIMULUS_NAME,
        "--notation-file",
        str(STIMULUS_NOTATION),
    ])


def resolve_external_clip(module, external_source: Path | None, external_seconds: float) -> tuple[Path, dict[str, object]]:
    if external_source is None:
        if not DEFAULT_EXTERNAL_CLIP.exists():
            raise RuntimeError(
                "No tracked external benchmark input is available. Provide --external-source <media-file> or recreate .tmp/gui-e2e/external_clip.mp4 before rerunning the exact real-world benchmark."
            )

        return DEFAULT_EXTERNAL_CLIP.resolve(), {
            "source_mode": "existing-clip",
            "clip_path": make_repo_relative(DEFAULT_EXTERNAL_CLIP),
            "clip_sha256": sha256_file(DEFAULT_EXTERNAL_CLIP),
        }

    backend = module.detect_backend()
    ffmpeg_path = backend.ffmpeg_path or "ffmpeg"
    if external_seconds <= 0:
      raise RuntimeError("--external-seconds must be greater than zero.")

    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    clipped_output = (RUNTIME_ROOT / "external-benchmark-source.mp4").resolve()
    if clipped_output.exists():
        clipped_output.unlink()

    run_command([
        ffmpeg_path,
        "-y",
        "-ss",
        "0",
        "-t",
        str(external_seconds),
        "-i",
        str(external_source.resolve()),
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        str(clipped_output),
    ])

    return clipped_output, {
        "source_mode": "trimmed-from-external-source",
        "external_source": make_repo_relative(external_source),
        "external_source_sha256": sha256_file(external_source.resolve()),
        "clip_path": make_repo_relative(clipped_output),
        "clip_sha256": sha256_file(clipped_output),
        "clip_seconds": round(external_seconds, 3),
    }


def collect_environment(module) -> dict[str, object]:
    backend = module.detect_backend()
    environment: dict[str, object] = {
        "python_executable": backend.python_executable,
        "ffmpeg_path": backend.ffmpeg_path,
        "ffprobe_path": backend.ffprobe_path,
        "torch_available": backend.torch_available,
        "torch_cuda_available": backend.torch_cuda_available,
        "torchcrepe_available": backend.torchcrepe_available,
    }

    if backend.torch_available:
        import torch

        environment.update({
            "torch_version": torch.__version__,
            "cuda_version": torch.version.cuda,
            "device_count": torch.cuda.device_count(),
            "device_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        })

    return environment


def main() -> int:
    args = parse_args()
    module = load_preprocess_module()

    ensure_stimulus_fixture()
    external_clip, external_info = resolve_external_clip(module, args.external_source, args.external_seconds)

    stimulus_output = (RUNTIME_ROOT / "stimulus-gpu").resolve()
    real_output = (RUNTIME_ROOT / "realworld-gpu").resolve()

    shutil.rmtree(stimulus_output, ignore_errors=True)
    shutil.rmtree(real_output, ignore_errors=True)
    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    stimulus_output.mkdir(parents=True, exist_ok=True)
    real_output.mkdir(parents=True, exist_ok=True)

    with wave.open(str(STIMULUS_INPUT.resolve()), "rb") as wav_file:
        stimulus_duration = wav_file.getnframes() / wav_file.getframerate()

    real_probe = module.probe_media(external_clip)
    real_duration = float(real_probe["format"]["duration"])

    start = time.perf_counter()
    stimulus_payload = module.analyze_media(
        STIMULUS_INPUT.resolve(),
        stimulus_output,
        pitch_model="torch-cuda",
        pitch_source="original",
        processing_device="gpu",
        bypass_cache=True,
    )
    stimulus_elapsed = time.perf_counter() - start

    start = time.perf_counter()
    real_payload = module.analyze_media(
        external_clip,
        real_output,
        stem_model="HTDemucs FT",
        separate=True,
        pitch_model="torch-cuda",
        pitch_source="vocals",
        processing_device="gpu",
        bypass_cache=True,
    )
    real_elapsed = time.perf_counter() - start

    summary = {
        "benchmark_spec": {
            "stimulus_notation": make_repo_relative(STIMULUS_NOTATION),
            "stimulus_wav": make_repo_relative(STIMULUS_INPUT),
            "stimulus_metadata": make_repo_relative(STIMULUS_METADATA),
            "stimulus_sha256": sha256_file(STIMULUS_INPUT),
            "stimulus_notation_sha256": sha256_file(STIMULUS_NOTATION),
            "external_benchmark": external_info,
        },
        "environment": collect_environment(module),
        "calibrated_stimulus": {
            "duration_seconds": round(stimulus_duration, 3),
            "elapsed_seconds": round(stimulus_elapsed, 3),
            "pitch_model_requested": stimulus_payload.get("pitch_model_requested"),
            "pitch_model_used": stimulus_payload.get("pitch_model_used"),
            "processing_device_requested": stimulus_payload.get("processing_device_requested"),
            "processing_device_used": stimulus_payload.get("processing_device_used"),
            "analysis_source": stimulus_payload.get("analysis_source", {}).get("kind"),
            "cache_status": stimulus_payload.get("cache_status"),
        },
        "realworld_10s": {
            "duration_seconds": round(real_duration, 3),
            "elapsed_seconds": round(real_elapsed, 3),
            "pitch_model_requested": real_payload.get("pitch_model_requested"),
            "pitch_model_used": real_payload.get("pitch_model_used"),
            "processing_device_requested": real_payload.get("processing_device_requested"),
            "processing_device_used": real_payload.get("processing_device_used"),
            "analysis_source": real_payload.get("analysis_source", {}).get("kind"),
            "cache_status": real_payload.get("cache_status"),
            "separation_status": (real_payload.get("separation") or {}).get("status"),
        },
    }

    if args.write_baseline:
        baseline_path = args.write_baseline if args.write_baseline.is_absolute() else (ROOT / args.write_baseline)
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        baseline_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())