from __future__ import annotations

import argparse
import array
import importlib.util
import json
import math
import os
import subprocess
import shutil
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
import wave

SUPPORTED_STEM_MODELS = [
    "Vocals Mel-Band Roformer",
    "HTDemucs FT",
    "HTDemucs 6 Stem",
    "MDX23C",
    "UVR MDX Karaoke",
    "Spleeter 2 Stem",
    "Open-Unmix",
]

SUPPORTED_PITCH_MODELS = ["yin", "torch-cuda", "other"]
SUPPORTED_PITCH_SOURCES = ["original", "vocals", "other"]
SUPPORTED_PROCESSING_DEVICES = ["auto", "gpu", "cpu"]
ANALYSIS_CACHE_VERSION = 9
PITCH_LOW_PASS_CUTOFF_HZ = 1400.0
HARMONIC_LAG_FACTORS = (2, 3, 4)
HARMONIC_LAG_ABSOLUTE_TOLERANCE = 0.08
HARMONIC_LAG_RATIO_TOLERANCE = 1.6
OCTAVE_GLITCH_TOLERANCE_SEMITONES = 0.75
SUBHARMONIC_STRENGTH_RATIO = 0.12


def torchcrepe_is_available() -> bool:
    return importlib.util.find_spec("torchcrepe") is not None


def torch_cuda_is_available() -> bool:
    if importlib.util.find_spec("torch") is None:
        return False

    import torch as torch_module

    return bool(torch_module.cuda.is_available())


def resolve_processing_device(requested_device: str | None) -> tuple[str, str]:
    normalized = (requested_device or "auto").strip().lower()
    if normalized not in SUPPORTED_PROCESSING_DEVICES:
        raise RuntimeError(f"Unsupported processing device '{requested_device}'.")

    if normalized == "cpu":
        return normalized, "cpu"

    if torch_cuda_is_available():
        return normalized, "cuda"

    return normalized, "cpu"


def resolve_pitch_model(requested_model: str | None, processing_device: str | None = None) -> tuple[str, str]:
    normalized = (requested_model or "yin").strip().lower()
    if normalized not in SUPPORTED_PITCH_MODELS:
        raise RuntimeError(f"Unsupported pitch model '{requested_model}'.")

    if normalized == "yin":
        return normalized, "yin"

    if normalized == "torch-cuda":
        _, effective_device = resolve_processing_device(processing_device)
        if torchcrepe_is_available() and effective_device == "cuda":
            return normalized, "torch-cuda"
        return normalized, "yin"

    # Alternative backends are exposed in the product surface, but the deterministic
    # preprocessing path currently falls back to YIN until those engines are wired.
    return normalized, "yin"


def resolve_pitch_source(requested_source: str | None) -> str:
    normalized = (requested_source or "vocals").strip().lower()
    if normalized not in SUPPORTED_PITCH_SOURCES:
        raise RuntimeError(f"Unsupported pitch source '{requested_source}'.")

    return normalized


def format_processing_device_label(device: str) -> str:
    return "GPU" if device == "cuda" else "CPU"


def log_message(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def log_progress(stage: str, percent: int, detail: str) -> None:
    clamped = max(0, min(100, percent))
    log_message(f"progress: {stage} {clamped} {detail}")


def find_windows_winget_binary(binary_name: str) -> str | None:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        return None

    packages_root = Path(local_app_data) / "Microsoft" / "WinGet" / "Packages"
    if not packages_root.exists():
        return None

    matches = sorted(packages_root.glob(f"**/{binary_name}.exe"), reverse=True)
    if not matches:
        return None

    return str(matches[0])


def find_binary(binary_name: str) -> str | None:
    env_lookup = {
        "ffmpeg": "PITCHVIEW_FFMPEG_PATH",
        "ffprobe": "PITCHVIEW_FFPROBE_PATH",
    }

    env_var = env_lookup.get(binary_name)
    if env_var:
        env_path = os.environ.get(env_var)
        if env_path and Path(env_path).exists():
            return env_path

    return shutil.which(binary_name) or find_windows_winget_binary(binary_name)


def is_fresh_cache(output_path: Path, input_path: Path) -> bool:
    return output_path.exists() and output_path.stat().st_mtime >= input_path.stat().st_mtime


def are_fresh_caches(output_paths: list[Path], input_path: Path) -> bool:
    return bool(output_paths) and all(is_fresh_cache(path, input_path) for path in output_paths)


@dataclass
class BackendStatus:
    ffmpeg_available: bool
    ffprobe_available: bool
    ffmpeg_path: str | None
    ffprobe_path: str | None
    demucs_available: bool
    spleeter_available: bool
    torch_available: bool
    torch_cuda_available: bool
    torchcrepe_available: bool
    python_executable: str
    available_stem_models: list[str]
    available_pitch_models: list[str]


def detect_backend() -> BackendStatus:
    ffmpeg_path = find_binary("ffmpeg")
    ffprobe_path = find_binary("ffprobe")

    return BackendStatus(
        ffmpeg_available=ffmpeg_path is not None,
        ffprobe_available=ffprobe_path is not None,
        ffmpeg_path=ffmpeg_path,
        ffprobe_path=ffprobe_path,
        demucs_available=importlib.util.find_spec("demucs") is not None,
        spleeter_available=shutil.which("spleeter") is not None,
        torch_available=importlib.util.find_spec("torch") is not None,
        torch_cuda_available=torch_cuda_is_available(),
        torchcrepe_available=torchcrepe_is_available(),
        python_executable=sys.executable,
        available_stem_models=SUPPORTED_STEM_MODELS,
        available_pitch_models=SUPPORTED_PITCH_MODELS,
    )


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, capture_output=True, text=True)


def require_backend_tools() -> BackendStatus:
    backend = detect_backend()

    if not backend.ffmpeg_available or not backend.ffprobe_available:
        raise RuntimeError("FFmpeg and ffprobe must be resolvable for desktop preprocessing.")

    return backend


def discover_existing_stems(output_dir: Path) -> list[dict[str, str]]:
    candidates = []

    for kind, filename, label in [
        ("vocals", "vocals.wav", "Vocals stem"),
        ("other", "other.wav", "Other stem"),
    ]:
        path = output_dir / filename
        if path.exists():
            candidates.append({
                "kind": kind,
                "label": label,
                "path": str(path),
            })

    return candidates


def stems_are_fresh(output_dir: Path, input_path: Path) -> bool:
    candidates = [output_dir / "vocals.wav", output_dir / "other.wav"]
    return all(is_fresh_cache(path, input_path) for path in candidates)


def copy_stem_if_exists(source: Path, destination: Path) -> bool:
    if not source.exists():
        return False

    ensure_parent(destination)
    shutil.copyfile(source, destination)
    return True


def separate_stems(
    input_path: Path,
    output_dir: Path,
    model_name: str,
    bypass_cache: bool = False,
    processing_device: str | None = None,
) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    expected_stem_count = 6 if model_name == "HTDemucs 6 Stem" else 2
    requested_processing_device, effective_processing_device = resolve_processing_device(processing_device)
    log_message(f"phase: stem-separating started model={model_name} input={input_path}")
    log_progress("stem-separating", 5, f"Preparing {model_name} stem separation ({expected_stem_count} stems)")
    existing = discover_existing_stems(output_dir)
    if not bypass_cache and existing and stems_are_fresh(output_dir, input_path):
        log_message("phase: stem-separating cached")
        log_progress("stem-separating", 100, f"Used cached {model_name} stem separation ({expected_stem_count} stems)")
        return {
            "action": "separate-stems",
            "input": str(input_path),
            "output_dir": str(output_dir),
            "status": "cached",
            "model": model_name,
            "sources": existing,
        }

    backend = require_backend_tools()

    demucs_models = {
        "HTDemucs FT": "htdemucs_ft",
        "HTDemucs 6 Stem": "htdemucs_6s",
    }

    if model_name in demucs_models:
        if not backend.demucs_available:
            raise RuntimeError(f"Model '{model_name}' requires demucs, which is not installed in the Python environment.")

        import torch as torch_module
        from demucs.apply import apply_model
        from demucs.pretrained import get_model

        model = get_model(demucs_models[model_name])
        model.to(effective_processing_device)
        model.eval()
        log_message(
            f"separate_stems: loaded demucs model={demucs_models[model_name]} device={effective_processing_device}"
        )
        log_progress(
            "stem-separating",
            20,
            f"Loaded {model_name} ({expected_stem_count} stems) on {format_processing_device_label(effective_processing_device)}",
        )

        demucs_input_path = input_path
        if input_path.suffix.lower() != ".wav":
            demucs_input_path = output_dir / "playback.wav"
            if not is_fresh_cache(demucs_input_path, input_path):
                create_playback_audio(input_path, demucs_input_path)
            log_message(f"separate_stems: using playback proxy for demucs input={demucs_input_path}")
            log_progress("stem-separating", 35, "Prepared audio for separation")

        wav = load_demucs_track(demucs_input_path, model.audio_channels, model.samplerate, torch_module).clone()
        log_progress("stem-separating", 50, "Decoded source audio")
        ref = wav.mean(0)
        ref_mean = ref.mean()
        ref_std = ref.std().clamp_min(1e-8)
        wav = wav - ref_mean
        wav = wav / ref_std

        sources = apply_model(
            model,
            wav[None],
            device=effective_processing_device,
            shifts=1,
            split=True,
            overlap=0.25,
            progress=False,
            num_workers=0,
            segment=None,
        )[0]
        log_progress("stem-separating", 78, f"Separated {expected_stem_count} stems")
        sources = sources * ref_std
        sources = sources + ref_mean

        source_names = list(model.sources)
        vocals_index = source_names.index("vocals")
        vocals_source = sources[vocals_index]
        other_source = torch_module.zeros_like(vocals_source)
        for index, source in enumerate(sources):
            if index != vocals_index:
                other_source += source

        save_wav_tensor(vocals_source, output_dir / "vocals.wav", model.samplerate)
        save_wav_tensor(other_source, output_dir / "other.wav", model.samplerate)
        log_progress("stem-separating", 92, "Wrote stem files")
        log_message("phase: stem-separating completed")
        log_progress("stem-separating", 100, f"Stem separation complete for {model_name}")
        sources = discover_existing_stems(output_dir)

        if not sources:
            raise RuntimeError(f"Stem separation ran for '{model_name}' but did not produce expected vocals/other outputs.")

        return {
            "action": "separate-stems",
            "input": str(input_path),
            "output_dir": str(output_dir),
            "status": "completed",
            "model": model_name,
            "processing_device_requested": requested_processing_device,
            "processing_device_used": effective_processing_device,
            "sources": sources,
        }

    unsupported = {"Vocals Mel-Band Roformer", "MDX23C", "UVR MDX Karaoke", "Spleeter 2 Stem", "Open-Unmix"}
    if model_name in unsupported:
        raise RuntimeError(
            f"Model '{model_name}' is recognized but not yet wired to an installed local backend. "
            "Install the matching separator backend or choose HTDemucs FT / HTDemucs 6 Stem."
        )

    raise RuntimeError(f"Unsupported stem model '{model_name}'.")


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def probe_media(input_path: Path) -> dict[str, object]:
    backend = require_backend_tools()
    log_message(f"probe_media: input={input_path}")
    result = run_command([
        backend.ffprobe_path or "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,sample_rate,channels,width,height",
        "-of",
        "json",
        str(input_path),
    ])
    return json.loads(result.stdout)


def normalize_media(input_path: Path, output_path: Path) -> dict[str, object]:
    backend = require_backend_tools()
    ensure_parent(output_path)
    log_message(f"normalize_media: input={input_path} output={output_path}")
    run_command([
        backend.ffmpeg_path or "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "44100",
        "-af",
        "loudnorm=I=-18:TP=-1.5:LRA=11",
        str(output_path),
    ])
    return {
        "action": "normalize",
        "input": str(input_path),
        "output": str(output_path),
        "status": "completed",
        "level_for_pitch": True,
        "note": "FFmpeg normalization completed with loudness leveling for pitch analysis."
    }


def create_playback_audio(input_path: Path, output_path: Path) -> dict[str, object]:
    backend = require_backend_tools()
    ensure_parent(output_path)
    log_message(f"create_playback_audio: input={input_path} output={output_path}")
    run_command([
        backend.ffmpeg_path or "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ])
    return {
        "action": "create-playback-audio",
        "input": str(input_path),
        "output": str(output_path),
        "status": "completed",
    }


def create_display_video(input_path: Path, output_path: Path) -> dict[str, object]:
    backend = require_backend_tools()
    ensure_parent(output_path)
    log_message(f"create_display_video: input={input_path} output={output_path}")
    run_command([
        backend.ffmpeg_path or "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(output_path),
    ])
    return {
        "action": "create-display-video",
        "input": str(input_path),
        "output": str(output_path),
        "status": "completed",
    }


def media_has_video_stream(probe: dict[str, object]) -> bool:
    streams = probe.get("streams", [])
    if not isinstance(streams, list):
        return False

    return any(isinstance(stream, dict) and stream.get("codec_type") == "video" for stream in streams)


def level_amplitudes(amplitudes: list[float], target_level: float = 0.18) -> list[float]:
    leveled: list[float] = []

    for amplitude in amplitudes:
        bounded = max(abs(amplitude), 1e-4)
        gain = min(6.0, max(0.35, target_level / bounded))
        leveled.append(round(min(1.0, amplitude * gain), 6))

    return leveled


def low_pass_filter_samples(samples: list[float], sample_rate: int, cutoff_hz: float = PITCH_LOW_PASS_CUTOFF_HZ) -> list[float]:
    if len(samples) < 3 or sample_rate <= 0 or cutoff_hz <= 0:
        return samples[:]

    dt = 1.0 / sample_rate
    rc = 1.0 / (2.0 * math.pi * cutoff_hz)
    alpha = dt / (rc + dt)

    def filter_once(values: list[float]) -> list[float]:
        filtered = [values[0]]
        previous = values[0]
        for value in values[1:]:
            previous = previous + alpha * (value - previous)
            filtered.append(previous)
        return filtered

    forward = filter_once(samples)
    backward = filter_once(list(reversed(forward)))
    return list(reversed(backward))


def prepare_pitch_detection_samples(samples: list[float], sample_rate: int) -> list[float]:
    return low_pass_filter_samples(samples, sample_rate)


def measure_frequency_presence(frame: list[float], sample_rate: int, frequency_hz: float) -> float:
    if not frame or sample_rate <= 0 or frequency_hz <= 0 or frequency_hz >= sample_rate / 2:
        return 0.0

    cosine_total = 0.0
    sine_total = 0.0

    for index, sample in enumerate(frame):
        angle = (2.0 * math.pi * frequency_hz * index) / sample_rate
        cosine_total += sample * math.cos(angle)
        sine_total += sample * math.sin(angle)

    return math.sqrt(cosine_total * cosine_total + sine_total * sine_total) / len(frame)


def choose_fundamental_lag(best_lag: int, normalized_difference: list[float], min_lag: int, max_lag: int, frame: list[float], sample_rate: int) -> tuple[int, float]:
    selected_lag = best_lag
    selected_value = normalized_difference[best_lag]
    selected_pitch = sample_rate / best_lag
    selected_strength = measure_frequency_presence(frame, sample_rate, selected_pitch)

    for factor in HARMONIC_LAG_FACTORS:
        harmonic_lag = best_lag * factor
        if harmonic_lag > max_lag:
            break

        candidate_start = max(min_lag, harmonic_lag - 1)
        candidate_end = min(max_lag, harmonic_lag + 1)
        candidate_lag = min(range(candidate_start, candidate_end + 1), key=lambda lag: normalized_difference[lag])
        candidate_value = normalized_difference[candidate_lag]
        candidate_pitch = sample_rate / candidate_lag
        candidate_strength = measure_frequency_presence(frame, sample_rate, candidate_pitch)

        if (
            candidate_value <= selected_value + HARMONIC_LAG_ABSOLUTE_TOLERANCE
            and candidate_value <= selected_value * HARMONIC_LAG_RATIO_TOLERANCE
            and candidate_strength >= max(0.01, selected_strength * SUBHARMONIC_STRENGTH_RATIO)
        ):
            selected_lag = candidate_lag
            selected_value = candidate_value
            selected_pitch = candidate_pitch
            selected_strength = candidate_strength

    return selected_lag, selected_value


def deglitch_pitch_contour(contour: list[float], confidence: list[float]) -> list[float]:
    if not contour:
        return []

    smoothed = contour[:]

    for index in range(1, len(contour) - 1):
        previous = contour[index - 1]
        current = contour[index]
        next_value = contour[index + 1]

        if previous <= 0 or current <= 0 or next_value <= 0:
            continue

        jump_from_previous = abs(12 * math.log2(current / previous))
        jump_to_next = abs(12 * math.log2(current / next_value))
        surrounding_jump = abs(12 * math.log2(next_value / previous))

        if jump_from_previous > 3.5 and jump_to_next > 3.5 and surrounding_jump < 1.5 and confidence[index] < 0.92:
            smoothed[index] = round((previous + next_value) / 2, 6)

    return smoothed


def suppress_octave_glitches(contour: list[float], confidence: list[float]) -> list[float]:
    if len(contour) < 3:
        return contour[:]

    repaired = contour[:]

    for index in range(1, len(repaired) - 1):
        previous = repaired[index - 1]
        current = repaired[index]
        next_value = repaired[index + 1]

        if previous <= 0 or current <= 0 or next_value <= 0:
            continue

        surrounding_jump = abs(12 * math.log2(next_value / previous))
        if surrounding_jump > 2.0:
            continue

        anchor = math.sqrt(previous * next_value)
        current_confidence = confidence[index] if index < len(confidence) else 0.0
        previous_confidence = confidence[index - 1] if index - 1 < len(confidence) else 0.0
        next_confidence = confidence[index + 1] if index + 1 < len(confidence) else 0.0

        if max(previous_confidence, next_confidence) < 0.34:
            continue

        octave_up_error = abs(12 * math.log2(current / anchor) - 12)
        octave_down_error = abs(12 * math.log2(current / anchor) + 12)

        if octave_up_error <= OCTAVE_GLITCH_TOLERANCE_SEMITONES and current_confidence < 0.96:
            repaired[index] = round(current / 2.0, 6)
            continue

        if octave_down_error <= OCTAVE_GLITCH_TOLERANCE_SEMITONES and current_confidence < 0.96:
            repaired[index] = round(current * 2.0, 6)

    return repaired


def repair_pitch_dropouts(contour: list[float], confidence: list[float]) -> list[float]:
    repaired = contour[:]

    for index in range(1, len(repaired) - 1):
        if repaired[index] > 0:
            continue

        previous = repaired[index - 1]
        next_value = repaired[index + 1]
        if previous <= 0 or next_value <= 0:
            continue

        surrounding_jump = abs(12 * math.log2(next_value / previous))
        if surrounding_jump < 1.5 and confidence[index] < 0.6:
            repaired[index] = round((previous + next_value) / 2, 6)

    for index in range(1, len(repaired) - 2):
        if repaired[index] > 0 or repaired[index + 1] > 0:
            continue

        previous = repaired[index - 1]
        next_value = repaired[index + 2]
        if previous <= 0 or next_value <= 0:
            continue

        surrounding_jump = abs(12 * math.log2(next_value / previous))
        if surrounding_jump < 2.0 and confidence[index] < 0.6 and confidence[index + 1] < 0.6:
            step = (next_value - previous) / 3
            repaired[index] = round(previous + step, 6)
            repaired[index + 1] = round(previous + 2 * step, 6)

    return repaired


def compute_amplitude_envelope(samples: list[float], bucket_count: int = 64) -> list[float]:
    if not samples:
        return []

    bucket_size = max(1, len(samples) // bucket_count)
    peaks: list[float] = []

    for start in range(0, len(samples), bucket_size):
        bucket = samples[start:start + bucket_size]
        peaks.append(max((abs(value) for value in bucket), default=0.0))

        if len(peaks) >= bucket_count:
            break

    max_peak = max(peaks, default=1e-6)
    return [round(value / max_peak, 4) for value in peaks]


def estimate_pitch_hz(frame: list[float], sample_rate: int) -> tuple[float, float]:
    if not frame:
        return 0.0, 0.0

    frame_rms = math.sqrt(sum(value * value for value in frame) / len(frame))
    if frame_rms < 0.01:
        return 0.0, 0.0

    min_frequency = 80
    max_frequency = 1000
    min_lag = max(1, sample_rate // max_frequency)
    max_lag = min(max(min_lag + 1, sample_rate // min_frequency), len(frame) - 2)
    threshold = 0.12

    if max_lag <= min_lag:
        return 0.0, 0.0

    difference = [0.0] * (max_lag + 1)
    for lag in range(1, max_lag + 1):
        total = 0.0
        for index in range(len(frame) - lag):
            delta = frame[index] - frame[index + lag]
            total += delta * delta
        difference[lag] = total

    normalized_difference = [1.0] * (max_lag + 1)
    running_sum = 0.0
    for lag in range(1, max_lag + 1):
        running_sum += difference[lag]
        normalized_difference[lag] = (difference[lag] * lag / running_sum) if running_sum > 0 else 1.0

    best_lag = 0
    best_value = 1.0
    for lag in range(min_lag, max_lag + 1):
        value = normalized_difference[lag]
        if value < threshold:
            best_lag = lag
            while best_lag + 1 <= max_lag and normalized_difference[best_lag + 1] < normalized_difference[best_lag]:
                best_lag += 1
            best_value = normalized_difference[best_lag]
            break

        if value < best_value:
            best_value = value
            best_lag = lag

    if best_lag == 0:
        return 0.0, 0.0

    best_lag, best_value = choose_fundamental_lag(best_lag, normalized_difference, min_lag, max_lag, frame, sample_rate)

    refined_lag = float(best_lag)
    if 1 < best_lag < max_lag:
        previous = normalized_difference[best_lag - 1]
        current = normalized_difference[best_lag]
        next_value = normalized_difference[best_lag + 1]
        denominator = 2 * ((2 * current) - previous - next_value)
        if abs(denominator) > 1e-6:
            refined_lag = best_lag + (previous - next_value) / denominator

    pitch_hz = sample_rate / refined_lag
    confidence = max(0.0, min(1.0, 1.0 - best_value))
    if pitch_hz < min_frequency or pitch_hz > max_frequency or confidence < 0.1:
        return 0.0, 0.0

    return round(pitch_hz, 3), round(confidence, 4)


def load_wav_samples(wav_path: Path) -> tuple[list[float], int]:
    with wave.open(str(wav_path), "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        sample_width = wav_file.getsampwidth()
        channels = wav_file.getnchannels()
        raw_frames = wav_file.readframes(wav_file.getnframes())

    if sample_width != 2:
        raise RuntimeError("Expected 16-bit PCM wav output from FFmpeg normalization.")

    pcm = array.array("h")
    pcm.frombytes(raw_frames)
    samples = [sample / 32768.0 for sample in pcm]

    if channels > 1:
        collapsed: list[float] = []
        for index in range(0, len(samples), channels):
            frame = samples[index:index + channels]
            collapsed.append(sum(frame) / len(frame))
        samples = collapsed

    return samples, sample_rate


def load_demucs_track(wav_path: Path, target_channels: int, target_sample_rate: int, torch_module):
    with wave.open(str(wav_path), "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        sample_width = wav_file.getsampwidth()
        channels = wav_file.getnchannels()
        frame_count = wav_file.getnframes()
        raw_frames = wav_file.readframes(frame_count)

    if sample_width != 2:
        raise RuntimeError("Expected 16-bit PCM wav output for Demucs input.")

    import numpy as np
    from scipy import signal as scipy_signal

    pcm = np.frombuffer(raw_frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        pcm = pcm.reshape(-1, channels).T
    else:
        pcm = pcm.reshape(1, -1)

    if pcm.shape[0] != target_channels:
        if target_channels == 1:
            pcm = pcm.mean(axis=0, keepdims=True)
        elif pcm.shape[0] == 1:
            pcm = np.repeat(pcm, target_channels, axis=0)
        elif pcm.shape[0] > target_channels:
            pcm = pcm[:target_channels, :]
        else:
            repeats = math.ceil(target_channels / pcm.shape[0])
            pcm = np.tile(pcm, (repeats, 1))[:target_channels, :]

    if sample_rate != target_sample_rate:
        greatest_common_divisor = math.gcd(sample_rate, target_sample_rate)
        pcm = scipy_signal.resample_poly(
            pcm,
            target_sample_rate // greatest_common_divisor,
            sample_rate // greatest_common_divisor,
            axis=1,
        )

    return torch_module.from_numpy(pcm.copy())


def save_wav_tensor(audio_tensor, output_path: Path, sample_rate: int) -> None:
    import numpy as np

    ensure_parent(output_path)
    audio = audio_tensor.detach().cpu().numpy()
    if audio.ndim == 1:
        audio = audio[np.newaxis, :]

    audio = np.clip(audio, -1.0, 1.0)
    interleaved = (audio.T * 32767.0).astype("<i2", copy=False)

    with wave.open(str(output_path), "wb") as wav_file:
        wav_file.setnchannels(audio.shape[0])
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(interleaved.tobytes())


def level_sample_series(samples: list[float], target_level: float = 0.18) -> list[float]:
    if not samples:
        return []

    leveled: list[float] = []
    frame_size = 2048

    for start in range(0, len(samples), frame_size):
        frame = samples[start:start + frame_size]
        if not frame:
            continue
        rms = math.sqrt(sum(value * value for value in frame) / len(frame))
        gain = 1.0 if rms < 1e-4 else min(6.0, max(0.35, target_level / rms))
        leveled.extend(max(-1.0, min(1.0, value * gain)) for value in frame)

    return leveled


PITCH_POINTS_PER_SECOND = 48
MIN_PITCH_POINTS = 192
MAX_PITCH_POINTS = 12288
YIN_WINDOW_SECONDS = 0.05


def choose_pitch_point_count(samples: list[float], sample_rate: int) -> int:
    if not samples or sample_rate <= 0:
        return MIN_PITCH_POINTS

    duration_seconds = len(samples) / sample_rate
    target = round(duration_seconds * PITCH_POINTS_PER_SECOND)
    return max(MIN_PITCH_POINTS, min(MAX_PITCH_POINTS, target))


def ensure_torch_compatibility_shims(torch_module) -> None:
    try:
        __import__("torch.utils.serialization.config")
    except ModuleNotFoundError:
        return


def ensure_torchcrepe_loader_compatibility(torch_module, torchcrepe) -> None:
    model_loader = getattr(torchcrepe.load, "model", None)
    if model_loader is None or getattr(model_loader, "_pitchview_compatible", False):
        return

    def patched_model(device, capacity="full"):
        torchcrepe.infer.capacity = capacity
        torchcrepe.infer.model = torchcrepe.Crepe(capacity)

        checkpoint_path = os.path.join(os.path.dirname(torchcrepe.load.__file__), "assets", f"{capacity}.pth")
        state_dict = torch_module.load(checkpoint_path, map_location=device, weights_only=False)
        torchcrepe.infer.model.load_state_dict(state_dict)
        torchcrepe.infer.model = torchcrepe.infer.model.to(torch_module.device(device))
        torchcrepe.infer.model.eval()

    patched_model._pitchview_compatible = True
    torchcrepe.load.model = patched_model


def compute_pitch_contour_torch_cuda(
    samples: list[float],
    sample_rate: int,
    point_count: int,
    processing_device: str | None = None,
) -> tuple[list[float], list[float]]:
    import torch as torch_module
    ensure_torch_compatibility_shims(torch_module)
    import torchcrepe
    ensure_torchcrepe_loader_compatibility(torch_module, torchcrepe)

    if not samples:
        return [], []

    _, effective_processing_device = resolve_processing_device(processing_device)
    if effective_processing_device != "cuda":
        raise RuntimeError("Torch CUDA pitch detection requires a CUDA-capable processing device.")

    device = "cuda:0"
    hop_length = max(1, round(len(samples) / max(point_count - 1, 1)))
    audio = torch_module.tensor(samples, dtype=torch_module.float32, device=device).unsqueeze(0)

    pitch, periodicity = torchcrepe.predict(
        audio,
        sample_rate,
        hop_length,
        65.0,
        1200.0,
        "full",
        batch_size=2048,
        device=device,
        decoder=torchcrepe.decode.weighted_argmax,
        return_periodicity=True,
    )
    periodicity = torchcrepe.filter.median(periodicity, 3)
    pitch = torchcrepe.threshold.At(0.08)(pitch, periodicity)

    contour_tensor = pitch.squeeze(0).detach().cpu()
    confidence_tensor = periodicity.squeeze(0).detach().cpu()
    contour = [round(float(max(0.0, value)), 3) for value in contour_tensor.tolist()]
    confidence = [round(float(max(0.0, min(1.0, value))), 4) for value in confidence_tensor.tolist()]

    frame_size = max(hop_length * 2, round(sample_rate * 0.02))
    for index in range(len(contour)):
        start = min(index * hop_length, max(len(samples) - frame_size, 0))
        frame = samples[start:start + frame_size]
        if not frame:
            contour[index] = 0.0
            confidence[index] = 0.0
            continue

        rms = math.sqrt(sum(value * value for value in frame) / len(frame))
        if rms < 0.01 or confidence[index] < 0.08:
            contour[index] = 0.0
            confidence[index] = 0.0

    if len(contour) > point_count:
        contour = contour[:point_count]
        confidence = confidence[:point_count]
    elif len(contour) < point_count and contour:
        last_pitch = contour[-1]
        last_confidence = confidence[-1]
        while len(contour) < point_count:
            contour.append(last_pitch)
            confidence.append(last_confidence)

    repaired = deglitch_pitch_contour(contour, confidence)
    repaired = suppress_octave_glitches(repaired, confidence)
    repaired = repair_pitch_dropouts(repaired, confidence)
    return repaired, confidence


def compute_pitch_contour(
    samples: list[float],
    sample_rate: int,
    point_count: int = 48,
    pitch_model: str = "yin",
    processing_device: str | None = None,
) -> tuple[list[float], list[float]]:
    if not samples:
        return [], []

    _, effective_pitch_model = resolve_pitch_model(pitch_model, processing_device)
    if effective_pitch_model == "torch-cuda":
        return compute_pitch_contour_torch_cuda(samples, sample_rate, point_count, processing_device=processing_device)

    if effective_pitch_model != "yin":
        raise RuntimeError(f"Unsupported effective pitch model '{effective_pitch_model}'.")

    window_size = min(len(samples), max(1024, round(sample_rate * YIN_WINDOW_SECONDS)))
    available_span = max(len(samples) - window_size, 0)
    hop_size = max(1, available_span // max(point_count - 1, 1)) if available_span > 0 else window_size
    contour: list[float] = []
    confidence: list[float] = []

    for start in range(0, max(available_span, 0) + 1, hop_size):
        frame = samples[start:start + window_size]
        pitch_hz, pitch_confidence = estimate_pitch_hz(frame, sample_rate)
        contour.append(pitch_hz)
        confidence.append(pitch_confidence)

        if len(contour) >= point_count:
            break

    repaired = deglitch_pitch_contour(contour, confidence)
    repaired = suppress_octave_glitches(repaired, confidence)
    repaired = repair_pitch_dropouts(repaired, confidence)
    return repaired, confidence


def choose_pitch_analysis_source(input_path: Path, output_dir: Path, preferred_source_kind: str = "vocals") -> tuple[Path, str]:
    if preferred_source_kind == "vocals":
        vocals_path = output_dir / "vocals.wav"
        if vocals_path.exists():
            return vocals_path, "vocals"

    if preferred_source_kind == "other":
        other_path = output_dir / "other.wav"
        if other_path.exists():
            return other_path, "other"

    return input_path, "original"


def analyze_media(
    input_path: Path,
    output_dir: Path,
    stem_model: str | None = None,
    separate: bool = False,
    pitch_model: str | None = None,
    pitch_source: str | None = None,
    processing_device: str | None = None,
    bypass_cache: bool = False,
) -> dict[str, object]:
    backend = require_backend_tools()
    requested_processing_device, effective_processing_device = resolve_processing_device(processing_device)
    requested_pitch_model, effective_pitch_model = resolve_pitch_model(pitch_model, requested_processing_device)
    requested_pitch_source = resolve_pitch_source(pitch_source)
    log_message(
        "analyze_media: "
        f"input={input_path} output_dir={output_dir} separate={separate} stem_model={stem_model} "
        f"pitch_model={requested_pitch_model} effective_pitch_model={effective_pitch_model} "
        f"processing_device={requested_processing_device} effective_processing_device={effective_processing_device} "
        f"pitch_source={requested_pitch_source}"
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    probe = probe_media(input_path)
    input_has_video = media_has_video_stream(probe)
    planned_analysis_source = requested_pitch_source if separate and requested_pitch_source != "original" else choose_pitch_analysis_source(input_path, output_dir, requested_pitch_source)[1]
    playback_audio = output_dir / "playback.wav"
    display_video = output_dir / "display.mp4"
    normalized_wav = output_dir / f"normalized-{planned_analysis_source}-{effective_pitch_model}.wav"
    analysis_json = output_dir / f"analysis-{planned_analysis_source}-{effective_pitch_model}.json"

    cache_targets = [analysis_json, playback_audio, normalized_wav]
    if input_has_video:
        cache_targets.append(display_video)

    if not bypass_cache and are_fresh_caches(cache_targets, input_path):
        if not separate or (stem_model and stems_are_fresh(output_dir, input_path)):
            cached_payload = json.loads(analysis_json.read_text(encoding="utf-8"))
            if (
                cached_payload.get("analysis_cache_version") == ANALYSIS_CACHE_VERSION
                and (cached_payload.get("analysis_source") or {}).get("kind") == planned_analysis_source
                and cached_payload.get("pitch_model_requested") == requested_pitch_model
                and cached_payload.get("pitch_model_used") == effective_pitch_model
            ):
                cached_payload["cache_status"] = "hit"
                cached_payload.setdefault("processing_device_requested", requested_processing_device)
                cached_payload.setdefault("processing_device_used", effective_processing_device)
                log_message("phase: pitch-caching cached")
                log_progress("pitch-caching", 100, "Used cached pitch preprocessing")
                return cached_payload

    create_playback_audio(input_path, playback_audio)
    if input_has_video:
        create_display_video(input_path, display_video)

    separation_result = None
    if separate and stem_model:
        separation_result = separate_stems(
            input_path,
            output_dir,
            stem_model,
            bypass_cache=bypass_cache,
            processing_device=requested_processing_device,
        )

    analysis_input_path, analysis_source_kind = choose_pitch_analysis_source(input_path, output_dir, requested_pitch_source)
    log_message(f"analyze_media: analysis_source={analysis_source_kind} path={analysis_input_path}")
    log_message("phase: pitch-caching started")
    log_progress("pitch-caching", 8, f"Preparing {effective_pitch_model} pitch detection from {analysis_source_kind} audio")
    normalize_media(analysis_input_path, normalized_wav)
    log_progress("pitch-caching", 34, f"Normalized {analysis_source_kind} analysis audio")
    samples, sample_rate = load_wav_samples(normalized_wav)
    log_progress("pitch-caching", 56, "Loaded analysis samples")
    leveled_samples = level_sample_series(samples)
    log_progress("pitch-caching", 72, f"Leveled {analysis_source_kind} pitch input")
    pitch_input_samples = prepare_pitch_detection_samples(leveled_samples, sample_rate)
    pitch_point_count = choose_pitch_point_count(pitch_input_samples, sample_rate)
    amplitude_envelope = compute_amplitude_envelope(leveled_samples, pitch_point_count)
    pitch_contour, confidence = compute_pitch_contour(
        pitch_input_samples,
        sample_rate,
        point_count=pitch_point_count,
        pitch_model=effective_pitch_model,
        processing_device=requested_processing_device,
    )
    log_progress("pitch-caching", 90, "Computed contours and envelope")
    log_message(
        f"analyze_media: loaded_samples={len(samples)} amplitude_points={len(amplitude_envelope)} pitch_points={len(pitch_contour)}"
    )
    source_candidates = [
        {
            "kind": "original",
            "label": "Original",
            "path": str(playback_audio),
        },
        {
            "kind": "normalized",
            "label": "Normalized audio",
            "path": str(normalized_wav),
        },
    ]

    source_candidates.extend(discover_existing_stems(output_dir))

    payload = {
        "input": str(input_path),
        "analysis_source": {
            "kind": analysis_source_kind,
            "path": str(analysis_input_path),
        },
        "playback_audio": str(playback_audio),
        "display_video": str(display_video) if input_has_video else None,
        "normalized_audio": str(normalized_wav),
        "analysis_json": str(analysis_json),
        "analysis_cache_version": ANALYSIS_CACHE_VERSION,
        "pitch_model_requested": requested_pitch_model,
        "pitch_model_used": effective_pitch_model,
        "processing_device_requested": requested_processing_device,
        "processing_device_used": effective_processing_device,
        "cache_status": "miss",
        "sources": source_candidates,
        "separation": separation_result,
        "amplitudes": amplitude_envelope,
        "pitch_hz": pitch_contour,
        "confidence": confidence,
        "note": (
            f"Desktop analysis generated from {analysis_source_kind} audio with FFmpeg-normalized, "
            f"leveled and harmonic-suppressed pitch input, octave-glitch repair, short-dropout repair, and {effective_pitch_model} pitch detection "
            f"on {format_processing_device_label(effective_processing_device)}."
        ),
        "probe": probe,
        "ffmpeg": backend.ffmpeg_path,
    }
    analysis_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    log_message("phase: pitch-caching completed")
    log_progress("pitch-caching", 100, "Pitch preprocessing complete")
    log_message(f"analyze_media: wrote {analysis_json}")
    return payload


def repair_pitch_json(input_path: Path, output_path: Path) -> dict[str, object]:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    amplitudes = [float(value) for value in payload.get("amplitudes", [])]
    contour = [float(value) for value in payload.get("pitch_hz", [])]
    confidence = [float(value) for value in payload.get("confidence", [1.0] * len(contour))]
    repaired = {
        "amplitudes": level_amplitudes(amplitudes),
        "pitch_hz": suppress_octave_glitches(deglitch_pitch_contour(contour, confidence), confidence),
        "confidence": confidence,
        "note": "Pitch input leveled for wide amplitude variation and display glitches suppressed."
    }
    output_path.write_text(json.dumps(repaired, indent=2), encoding="utf-8")
    return {
        "action": "repair-pitch-json",
        "input": str(input_path),
        "output": str(output_path),
        "status": "completed",
        "points": len(contour)
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PitchView preprocessing entrypoint")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("check-backend", help="Report backend and model availability")

    normalize_parser = subparsers.add_parser("normalize", help="Plan normalization for an input file")
    normalize_parser.add_argument("input", type=Path)
    normalize_parser.add_argument("output", type=Path)

    probe_parser = subparsers.add_parser("probe", help="Probe media details using ffprobe")
    probe_parser.add_argument("input", type=Path)

    analyze_parser = subparsers.add_parser("analyze-media", help="Normalize and analyze a media file for desktop playback overlays")
    analyze_parser.add_argument("input", type=Path)
    analyze_parser.add_argument("output_dir", type=Path)
    analyze_parser.add_argument("--separate-stems", action="store_true")
    analyze_parser.add_argument("--stem-model", type=str)
    analyze_parser.add_argument("--pitch-model", type=str, default="yin")
    analyze_parser.add_argument("--pitch-source", type=str, default="vocals")
    analyze_parser.add_argument("--processing-device", type=str, default="auto")
    analyze_parser.add_argument("--bypass-cache", action="store_true")

    separate_parser = subparsers.add_parser("separate-stems", help="Generate vocals and other stems into the analysis cache")
    separate_parser.add_argument("input", type=Path)
    separate_parser.add_argument("output_dir", type=Path)
    separate_parser.add_argument("model", type=str)
    separate_parser.add_argument("--processing-device", type=str, default="auto")
    separate_parser.add_argument("--bypass-cache", action="store_true")

    repair_parser = subparsers.add_parser("repair-pitch-json", help="Level amplitudes and deglitch a pitch contour JSON payload")
    repair_parser.add_argument("input", type=Path)
    repair_parser.add_argument("output", type=Path)

    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.command == "check-backend":
        print(json.dumps(asdict(detect_backend()), indent=2))
        return 0

    if args.command == "normalize":
        print(json.dumps(normalize_media(args.input, args.output), indent=2))
        return 0

    if args.command == "probe":
        print(json.dumps(probe_media(args.input), indent=2))
        return 0

    if args.command == "analyze-media":
        print(json.dumps(analyze_media(args.input, args.output_dir, args.stem_model, args.separate_stems, args.pitch_model, args.pitch_source, args.processing_device, args.bypass_cache), indent=2))
        return 0

    if args.command == "separate-stems":
        print(json.dumps(separate_stems(args.input, args.output_dir, args.model, args.bypass_cache, args.processing_device), indent=2))
        return 0

    if args.command == "repair-pitch-json":
        print(json.dumps(repair_pitch_json(args.input, args.output), indent=2))
        return 0

    raise ValueError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
