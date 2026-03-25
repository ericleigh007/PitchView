from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def build_audio_separator_command(
    source: Path | None,
    output: Path,
    model_filename: str,
    model_file_dir: Path,
    download_model_only: bool = False,
) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "audio_separator.utils.cli",
        "-m",
        model_filename,
        "--output_dir",
        str(output),
        "--model_file_dir",
        str(model_file_dir),
    ]

    if download_model_only:
        command.append("--download_model_only")

    if source is not None:
        command.append(str(source))

    return command


MODEL_BACKENDS = {
    "vocals_mel_band_roformer": {
        "backend": "audio_separator",
        "quality": "high",
        "outputs": ["vocals.wav", "other.wav"],
        "model_filename": "vocals_mel_band_roformer.ckpt",
    },
    "htdemucs_ft": {
        "backend": "demucs",
        "quality": "high",
        "outputs": ["vocals.wav", "no_vocals.wav"],
        "command": lambda source, output: [
            sys.executable,
            "-m",
            "demucs.separate",
            "-n",
            "htdemucs_ft",
            "--two-stems",
            "vocals",
            "-o",
            str(output),
            str(source),
        ],
    },
    "htdemucs_6s": {
        "backend": "demucs",
        "quality": "high",
        "outputs": ["vocals.wav", "drums.wav", "bass.wav", "other.wav", "guitar.wav", "piano.wav"],
        "command": lambda source, output: [
            sys.executable,
            "-m",
            "demucs.separate",
            "-n",
            "htdemucs_6s",
            "-o",
            str(output),
            str(source),
        ],
    },
    "mdx23c": {
        "backend": "audio_separator",
        "quality": "balanced",
        "outputs": ["vocals.wav", "instrumental.wav"],
        "model_filename": "MDX23C-8KFFT-InstVoc_HQ.ckpt",
    },
    "uvr_mdx_karaoke": {
        "backend": "audio_separator",
        "quality": "balanced",
        "outputs": ["vocals.wav", "karaoke.wav"],
        "model_filename": "UVR-MDX-NET-Kara-2.onnx",
    },
    "spleeter_2stem": {
        "backend": "spleeter",
        "quality": "fast",
        "outputs": ["vocals.wav", "accompaniment.wav"],
        "command": lambda source, output: [
            sys.executable,
            "-m",
            "spleeter",
            "separate",
            "-p",
            "spleeter:2stems",
            "-o",
            str(output),
            str(source),
        ],
    },
    "openunmix": {
        "backend": "openunmix",
        "quality": "balanced",
        "outputs": ["vocals.wav", "instrumental.wav"],
        "command": lambda source, output: [
            sys.executable,
            "-m",
            "openunmix",
            str(source),
            str(output),
        ],
    },
}


def is_module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def resolve_model_file(model_id: str, explicit_model_file: str | None = None) -> tuple[str, bool]:
    model = MODEL_BACKENDS[model_id]
    default_model_filename = model.get("model_filename")
    if not default_model_filename:
        return "", False

    if explicit_model_file:
        explicit_path = Path(explicit_model_file).expanduser()
        return str(explicit_path), explicit_path.exists()

    env_override = os.environ.get("PITCHVIEW_MODEL_FILE")
    if env_override:
        env_path = Path(env_override).expanduser()
        return str(env_path), env_path.exists()

    search_roots = [
        Path.cwd(),
        Path.cwd() / "models",
        Path.cwd() / "checkpoints",
        Path.cwd() / ".models",
    ]

    for root in search_roots:
        candidate = root / default_model_filename
        if candidate.exists():
            return str(candidate), True

    return default_model_filename, False


def derive_audio_separator_model_context(model_id: str, explicit_model_file: str | None = None) -> tuple[str, Path, str | None, bool, bool]:
    resolved_model_file, model_file_exists = resolve_model_file(model_id, explicit_model_file)
    if Path(resolved_model_file).suffix and ("\\" in resolved_model_file or "/" in resolved_model_file or Path(resolved_model_file).is_absolute()):
        model_path = Path(resolved_model_file)
        model_filename = model_path.name
        model_file_dir = model_path.parent
        explicit_path_required = True
    elif model_file_exists:
        model_path = Path(resolved_model_file)
        model_filename = model_path.name
        model_file_dir = model_path.parent
        explicit_path_required = False
    else:
        model_filename = resolved_model_file
        model_file_dir = Path.cwd() / "models"
        explicit_path_required = explicit_model_file is not None

    model_file_dir.mkdir(parents=True, exist_ok=True)
    model_download_required = not model_file_exists and not explicit_path_required
    return model_filename, model_file_dir, resolved_model_file, model_file_exists, model_download_required


def build_model_command(source: Path, output_dir: Path, model_id: str, explicit_model_file: str | None = None) -> tuple[list[str], str | None, bool, Path | None, bool]:
    model = MODEL_BACKENDS[model_id]
    if model["backend"] == "audio_separator":
        model_filename, model_file_dir, resolved_model_file, model_file_exists, model_download_required = derive_audio_separator_model_context(
            model_id, explicit_model_file
        )
        return (
            build_audio_separator_command(source, output_dir, model_filename, model_file_dir),
            resolved_model_file,
            model_file_exists,
            model_file_dir,
            model_download_required,
        )

    command = model["command"](source, output_dir)
    return command, None, False, None, False


def ensure_ffmpeg_shim_dir() -> Path | None:
    ffmpeg_executable, _ = resolve_ffmpeg_executable()
    if not ffmpeg_executable:
        return None

    shim_dir = Path(tempfile.gettempdir()) / "pitchview-ffmpeg-shim"
    shim_dir.mkdir(parents=True, exist_ok=True)

    ffmpeg_alias = shim_dir / "ffmpeg.exe"
    if not ffmpeg_alias.exists():
        shutil.copyfile(ffmpeg_executable, ffmpeg_alias)

    ffprobe_executable, _ = resolve_ffprobe_executable()
    if ffprobe_executable:
        ffprobe_alias = shim_dir / "ffprobe.exe"
        if not ffprobe_alias.exists():
            shutil.copyfile(ffprobe_executable, ffprobe_alias)

    return shim_dir


def build_backend_env(backend_name: str) -> dict[str, str] | None:
    if backend_name != "audio_separator":
        return None

    env = os.environ.copy()
    shim_dir = ensure_ffmpeg_shim_dir()
    if shim_dir is not None:
        existing_path = env.get("PATH", "")
        env["PATH"] = f"{shim_dir}{os.pathsep}{existing_path}" if existing_path else str(shim_dir)
    return env


def run_audio_separator_job(source: Path, output_dir: Path, model_filename: str, model_file_dir: Path) -> tuple[int, list[str], str, str]:
    original_path = os.environ.get("PATH", "")
    env = build_backend_env("audio_separator") or os.environ.copy()
    os.environ["PATH"] = env.get("PATH", original_path)

    try:
        from audio_separator.separator import Separator

        separator = Separator(model_file_dir=str(model_file_dir), output_dir=str(output_dir))
        separator.load_model(model_filename)
        output_files = separator.separate(str(source)) or []
        resolved_outputs = [str(Path(output_file)) for output_file in output_files]
        return 0, resolved_outputs, "", ""
    except Exception as error:
        return 1, [], "", str(error)
    finally:
        os.environ["PATH"] = original_path


def find_generated_output_files(output_dir: Path, model_id: str) -> list[str]:
    expected_stems = [Path(name).stem.replace('.wav', '') for name in MODEL_BACKENDS[model_id]["outputs"]]
    discovered_files: list[Path] = []

    for candidate in output_dir.iterdir():
        if not candidate.is_file():
            continue

        lower_name = candidate.name.lower()
        if candidate.suffix.lower() not in {".wav", ".flac", ".mp3", ".m4a"}:
            continue

        if any(stem in lower_name for stem in expected_stems):
            discovered_files.append(candidate.resolve())

    discovered_files.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    return [str(path) for path in discovered_files]


def resolve_ffmpeg_executable() -> tuple[str | None, str | None]:
    ffmpeg_on_path = shutil.which("ffmpeg")
    if ffmpeg_on_path:
        return ffmpeg_on_path, "PATH"

    if is_module_available("imageio_ffmpeg"):
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe(), "imageio-ffmpeg"

    return None, None


def resolve_ffprobe_executable() -> tuple[str | None, str | None]:
    ffprobe_on_path = shutil.which("ffprobe")
    if ffprobe_on_path:
        return ffprobe_on_path, "PATH"

    ffmpeg_executable, source = resolve_ffmpeg_executable()
    if ffmpeg_executable:
        candidate = Path(ffmpeg_executable).with_name("ffprobe.exe")
        if candidate.exists():
            return str(candidate), source

    return None, None


def detect_backends() -> dict[str, bool]:
    ffmpeg_executable, ffmpeg_source = resolve_ffmpeg_executable()
    ffprobe_executable, ffprobe_source = resolve_ffprobe_executable()
    return {
        "python": True,
        "demucs": is_module_available("demucs"),
        "audio_separator": is_module_available("audio_separator"),
        "onnxruntime": is_module_available("onnxruntime"),
        "spleeter": is_module_available("spleeter"),
        "openunmix": is_module_available("openunmix"),
        "imageio_ffmpeg": is_module_available("imageio_ffmpeg"),
        "ffmpeg": ffmpeg_executable is not None,
        "ffmpegSource": ffmpeg_source,
        "ffprobe": ffprobe_executable is not None,
        "ffprobeSource": ffprobe_source,
    }


def normalize_audio(source: Path, output_path: Path) -> dict:
    ffmpeg_executable, ffmpeg_source = resolve_ffmpeg_executable()
    if not ffmpeg_executable:
        raise SystemExit("FFmpeg is not available on PATH and imageio-ffmpeg is not installed")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg_executable,
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "44100",
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    return {
        "source": str(source),
        "output": str(output_path),
        "ffmpeg": ffmpeg_executable,
        "ffmpegSource": ffmpeg_source,
        "command": command,
        "result": "completed" if completed.returncode == 0 else "failed",
        "returnCode": completed.returncode,
        "stdout": completed.stdout[-4000:],
        "stderr": completed.stderr[-4000:],
    }


def build_plan(source: Path, output_dir: Path, model_id: str, explicit_model_file: str | None = None) -> dict:
    if model_id not in MODEL_BACKENDS:
        raise SystemExit(f"Unknown model id: {model_id}")

    model = MODEL_BACKENDS[model_id]
    backend_status = detect_backends()
    backend_name = model["backend"]
    command, resolved_model_file, model_file_exists, model_file_dir, model_download_required = build_model_command(
        source, output_dir, model_id, explicit_model_file
    )

    notes = [
        "Use FFmpeg or ffprobe before separation when available to normalize and inspect inputs.",
        "Sidecar stem files are acceptable even if a multi-track container is not generated.",
    ]
    if resolved_model_file:
        notes.append(
            "Audio Separator models can be resolved via --model-file, PITCHVIEW_MODEL_FILE, or a local models/checkpoints directory."
        )
    if model_download_required:
        notes.append("The selected Audio Separator model is not present locally and can be downloaded into modelFileDir.")
    elif resolved_model_file and not model_file_exists:
        notes.append(f"Resolved model file was not found on disk: {resolved_model_file}")

    return {
        "source": str(source),
        "outputDir": str(output_dir),
        "modelId": model_id,
        "backend": backend_name,
        "backendAvailable": backend_status.get(backend_name, False),
        "ffmpegAvailable": backend_status["ffmpeg"],
        "ffprobeAvailable": backend_status["ffprobe"],
        "quality": model["quality"],
        "expectedOutputs": model["outputs"],
        "resolvedModelFile": resolved_model_file,
        "modelFileExists": model_file_exists,
        "modelFileDir": str(model_file_dir) if model_file_dir is not None else None,
        "modelDownloadRequired": model_download_required,
        "command": command,
        "notes": notes,
    }


def run_plan(source: Path, output_dir: Path, model_id: str, dry_run: bool, explicit_model_file: str | None = None) -> dict:
    plan = build_plan(source, output_dir, model_id, explicit_model_file)
    if dry_run:
        plan["result"] = "dry-run"
        return plan

    if not plan["backendAvailable"]:
        raise SystemExit(f"Selected backend is not installed for model {model_id}")
    if plan["resolvedModelFile"] and not plan["modelFileExists"] and not plan["modelDownloadRequired"]:
        raise SystemExit(f"Resolved model file does not exist: {plan['resolvedModelFile']}")

    output_dir.mkdir(parents=True, exist_ok=True)
    stdout = ""
    stderr = ""
    output_files: list[str] = []

    if plan["backend"] == "audio_separator":
        model_filename = Path(plan["resolvedModelFile"] or MODEL_BACKENDS[model_id]["model_filename"]).name
        model_file_dir = Path(plan["modelFileDir"])
        return_code, output_files, stdout, stderr = run_audio_separator_job(source, output_dir, model_filename, model_file_dir)
        if return_code == 0 and len(output_files) == 0:
            output_files = find_generated_output_files(output_dir, model_id)
        normalized_output_files = []
        for output_file in output_files:
            output_path = Path(output_file)
            if not output_path.is_absolute():
                output_path = output_dir / output_path
            normalized_output_files.append(str(output_path.resolve()))

        plan["outputFiles"] = normalized_output_files
        plan["result"] = "completed" if return_code == 0 and len(output_files) > 0 else "failed"
        plan["returnCode"] = return_code
    else:
        completed = subprocess.run(plan["command"], capture_output=True, text=True, env=build_backend_env(plan["backend"]))
        plan["result"] = "completed" if completed.returncode == 0 else "failed"
        plan["returnCode"] = completed.returncode
        stdout = completed.stdout
        stderr = completed.stderr

    if plan["result"] == "failed" and not stderr.strip():
        stderr = f"Worker returned {plan['result']} with code {plan['returnCode']} and produced {len(plan.get('outputFiles', []))} output files."

    plan["stdout"] = stdout[-4000:]
    plan["stderr"] = stderr[-4000:]
    return plan


def download_model(model_id: str, explicit_model_file: str | None = None) -> dict:
    if model_id not in MODEL_BACKENDS:
        raise SystemExit(f"Unknown model id: {model_id}")

    model = MODEL_BACKENDS[model_id]
    if model["backend"] != "audio_separator":
        raise SystemExit(f"Download command is currently implemented only for audio_separator-backed models: {model_id}")

    backend_status = detect_backends()
    if not backend_status.get("audio_separator", False):
        raise SystemExit("audio_separator backend is not installed")

    model_filename, model_file_dir, resolved_model_file, model_file_exists, model_download_required = derive_audio_separator_model_context(
        model_id, explicit_model_file
    )
    command = build_audio_separator_command(None, Path.cwd(), model_filename, model_file_dir, download_model_only=True)
    stdout = ""
    stderr = ""
    return_code = 0

    try:
        from audio_separator.separator import Separator

        separator = Separator(info_only=True, model_file_dir=str(model_file_dir), output_dir=str(Path.cwd()))
        separator.download_model_and_data(model_filename)
    except Exception as error:
        return_code = 1
        stderr = str(error)

    expected_files = [model_filename]
    if model_filename.endswith(".ckpt"):
        expected_files.append(f"{Path(model_filename).stem}.yaml")
        expected_files.append(f"{Path(model_filename).stem}_config.yaml")
    downloaded_files = sorted(path.name for path in model_file_dir.iterdir() if path.is_file())
    model_file_exists_after = (model_file_dir / model_filename).exists()
    result = "completed" if return_code == 0 and model_file_exists_after else "failed"

    return {
        "modelId": model_id,
        "backend": "audio_separator",
        "resolvedModelFile": resolved_model_file,
        "modelFileExistsBefore": model_file_exists,
        "modelFileExistsAfter": model_file_exists_after,
        "modelFileDir": str(model_file_dir),
        "modelDownloadRequired": model_download_required,
        "expectedFiles": expected_files,
        "command": command,
        "result": result,
        "returnCode": return_code,
        "downloadedFiles": downloaded_files,
        "stdout": stdout[-4000:],
        "stderr": stderr[-4000:],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="PitchView preprocessing worker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    detect_parser = subparsers.add_parser("detect", help="Report available preprocessing backends")
    detect_parser.set_defaults(action="detect")

    plan_parser = subparsers.add_parser("plan", help="Create a preprocess execution plan")
    plan_parser.add_argument("--source", required=True)
    plan_parser.add_argument("--output-dir", required=True)
    plan_parser.add_argument("--model-id", required=True)
    plan_parser.add_argument("--model-file")
    plan_parser.add_argument("--dry-run", action="store_true")
    plan_parser.set_defaults(action="plan")

    normalize_parser = subparsers.add_parser("normalize", help="Extract normalized mono PCM audio from a media file")
    normalize_parser.add_argument("--source", required=True)
    normalize_parser.add_argument("--output", required=True)
    normalize_parser.set_defaults(action="normalize")

    download_parser = subparsers.add_parser("download-model", help="Download a model file for a supported backend")
    download_parser.add_argument("--model-id", required=True)
    download_parser.add_argument("--model-file")
    download_parser.set_defaults(action="download-model")

    run_parser = subparsers.add_parser("run", help="Run a preprocess job if backend is installed")
    run_parser.add_argument("--source", required=True)
    run_parser.add_argument("--output-dir", required=True)
    run_parser.add_argument("--model-id", required=True)
    run_parser.add_argument("--model-file")
    run_parser.add_argument("--dry-run", action="store_true")
    run_parser.set_defaults(action="run")

    args = parser.parse_args()

    if args.action == "detect":
        print(json.dumps(detect_backends(), indent=2))
        return

    if args.action == "normalize":
        print(json.dumps(normalize_audio(Path(args.source), Path(args.output)), indent=2))
        return

    if args.action == "download-model":
        print(json.dumps(download_model(args.model_id, args.model_file), indent=2))
        return

    source = Path(args.source)
    output_dir = Path(args.output_dir)

    if args.action == "plan":
        print(json.dumps(build_plan(source, output_dir, args.model_id, args.model_file), indent=2))
        return

    print(json.dumps(run_plan(source, output_dir, args.model_id, args.dry_run, args.model_file), indent=2))


if __name__ == "__main__":
    main()