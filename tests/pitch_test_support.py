from __future__ import annotations

import json
import math
import wave
from pathlib import Path

from tools.stimulus_notation import parse_stimulus_notation, write_stimulus_fixture


SAMPLE_RATE = 44100
CHROMATIC_BPM = 144
THIRTY_SECOND_NOTE_SECONDS = 60.0 / CHROMATIC_BPM / 8.0
HALF_NOTE_SECONDS = 60.0 / CHROMATIC_BPM * 2.0
SLUR_EIGHTH_NOTE_SECONDS = 60.0 / CHROMATIC_BPM / 2.0


def midi_to_frequency(midi: int) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def note_name(midi: int) -> str:
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    return f"{names[midi % 12]}{(midi // 12) - 1}"


def apply_fades(samples: list[float], fade_sample_count: int = 192) -> list[float]:
    if not samples:
        return []

    count = min(fade_sample_count, len(samples) // 2)
    if count <= 0:
        return samples

    shaped = samples[:]
    for index in range(count):
      fade_in = index / count
      fade_out = (count - index) / count
      shaped[index] *= fade_in
      shaped[-(index + 1)] *= fade_out
    return shaped


def synthesize_frequency_curve(
    frequencies_hz: list[float],
    amplitude: float,
    sample_rate: int = SAMPLE_RATE,
    apply_segment_fades: bool = True,
) -> list[float]:
    if not frequencies_hz:
        return []

    harmonic_weights = [1.0, 0.42, 0.2, 0.1]
    normalization = sum(harmonic_weights)
    base_phase = 0.0
    samples: list[float] = []

    for frequency_hz in frequencies_hz:
        if frequency_hz <= 0:
            samples.append(0.0)
            continue

        base_phase += (2.0 * math.pi * frequency_hz) / sample_rate
        sample = (
            sum(math.sin(base_phase * harmonic) * weight for harmonic, weight in enumerate(harmonic_weights, start=1))
            / normalization
        ) * amplitude
        samples.append(sample)

    return apply_fades(samples) if apply_segment_fades else samples


def synthesize_tone(frequency_hz: float, duration_seconds: float, amplitude: float, sample_rate: int = SAMPLE_RATE) -> list[float]:
    sample_count = max(1, round(duration_seconds * sample_rate))
    return synthesize_frequency_curve([frequency_hz] * sample_count, amplitude, sample_rate)


def synthesize_rest(duration_seconds: float, sample_rate: int = SAMPLE_RATE) -> list[float]:
    sample_count = max(1, round(duration_seconds * sample_rate))
    return [0.0] * sample_count


def synthesize_slur(
    start_frequency_hz: float,
    end_frequency_hz: float,
    duration_seconds: float,
    amplitude: float,
    sample_rate: int = SAMPLE_RATE,
) -> list[float]:
    sample_count = max(2, round(duration_seconds * sample_rate))
    start_log = math.log2(max(start_frequency_hz, 1e-6))
    end_log = math.log2(max(end_frequency_hz, 1e-6))
    frequencies_hz = [
        2.0 ** (start_log + ((end_log - start_log) * index / max(sample_count - 1, 1)))
        for index in range(sample_count)
    ]
    return synthesize_frequency_curve(frequencies_hz, amplitude, sample_rate, apply_segment_fades=False)


def write_wav(path: Path, samples: list[float], sample_rate: int = SAMPLE_RATE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        frames = bytearray()
        for sample in samples:
            bounded = max(-0.999, min(0.999, sample))
            pcm = int(bounded * 32767)
            frames.extend(int(pcm).to_bytes(2, byteorder="little", signed=True))
        wav_file.writeframes(bytes(frames))


def write_pitch_fixture(base_dir: Path, name: str, segments: list[dict[str, float | int | str]], sample_rate: int = SAMPLE_RATE) -> dict[str, object]:
    base_dir.mkdir(parents=True, exist_ok=True)
    wav_path = base_dir / f"{name}.wav"
    json_path = base_dir / f"{name}.json"

    samples: list[float] = []
    timeline_segments: list[dict[str, object]] = []
    current_time = 0.0
    for index, segment in enumerate(segments):
        duration_seconds = float(segment["duration_seconds"])
        amplitude = float(segment["amplitude"])
        segment_type = str(segment.get("segment_type", "tone"))
        frequency_hz = float(segment.get("frequency_hz", 0.0))
        start_frequency_hz = float(segment.get("start_frequency_hz", frequency_hz))
        end_frequency_hz = float(segment.get("end_frequency_hz", frequency_hz))

        if segment_type == "rest":
            tone_samples = synthesize_rest(duration_seconds, sample_rate)
        elif segment_type == "slur":
            tone_samples = synthesize_slur(start_frequency_hz, end_frequency_hz, duration_seconds, amplitude, sample_rate)
        else:
            tone_samples = synthesize_tone(frequency_hz, duration_seconds, amplitude, sample_rate)

        samples.extend(tone_samples)
        start_time = current_time
        current_time += duration_seconds
        timeline_segments.append({
            "index": index,
            "segment_type": segment_type,
            "label": str(segment["label"]),
            "midi": int(segment.get("midi", -1)),
            "note": str(segment["note"]),
            "frequency_hz": round(frequency_hz, 6),
            "start_frequency_hz": round(start_frequency_hz, 6),
            "end_frequency_hz": round(end_frequency_hz, 6),
            "duration_seconds": round(duration_seconds, 6),
            "amplitude": round(amplitude, 6),
            "start_time_seconds": round(start_time, 6),
            "end_time_seconds": round(current_time, 6),
        })

    write_wav(wav_path, samples, sample_rate)
    payload = {
        "name": name,
        "sample_rate": sample_rate,
        "wav_path": str(wav_path),
        "metadata_path": str(json_path),
        "duration_seconds": round(current_time, 6),
        "segments": timeline_segments,
    }
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def create_fixed_pitch_level_fixtures(base_dir: Path, midi: int = 69) -> list[dict[str, object]]:
    frequency_hz = midi_to_frequency(midi)
    note = note_name(midi)
    fixtures = []
    for label, amplitude in [("low", 0.12), ("mid", 0.32), ("high", 0.7)]:
        fixtures.append(write_pitch_fixture(base_dir, f"fixed_{note}_{label}", [{
            "label": f"{note} {label}",
            "midi": midi,
            "note": note,
            "frequency_hz": frequency_hz,
            "duration_seconds": 1.8,
            "amplitude": amplitude,
        }]))
    return fixtures


def create_chromatic_run_fixture(base_dir: Path, start_midi: int = 57, semitone_span: int = 12) -> dict[str, object]:
    segments: list[dict[str, float | int | str]] = []
    start_note = note_name(start_midi)
    top_midi = start_midi + semitone_span
    top_note = note_name(top_midi)

    segments.append({
        "label": f"hold-start-{start_note}",
        "midi": start_midi,
        "note": start_note,
        "frequency_hz": midi_to_frequency(start_midi),
        "duration_seconds": HALF_NOTE_SECONDS,
        "amplitude": 0.36,
    })

    for midi in range(start_midi, top_midi + 1):
        segments.append({
            "label": f"up-{note_name(midi)}",
            "midi": midi,
            "note": note_name(midi),
            "frequency_hz": midi_to_frequency(midi),
            "duration_seconds": THIRTY_SECOND_NOTE_SECONDS,
            "amplitude": 0.32,
        })

    segments.append({
        "label": f"hold-top-{top_note}",
        "midi": top_midi,
        "note": top_note,
        "frequency_hz": midi_to_frequency(top_midi),
        "duration_seconds": HALF_NOTE_SECONDS,
        "amplitude": 0.38,
    })

    for midi in range(top_midi, start_midi - 1, -1):
        segments.append({
            "label": f"down-{note_name(midi)}",
            "midi": midi,
            "note": note_name(midi),
            "frequency_hz": midi_to_frequency(midi),
            "duration_seconds": THIRTY_SECOND_NOTE_SECONDS,
            "amplitude": 0.32,
        })

    segments.append({
        "label": f"hold-end-{start_note}",
        "midi": start_midi,
        "note": start_note,
        "frequency_hz": midi_to_frequency(start_midi),
        "duration_seconds": HALF_NOTE_SECONDS,
        "amplitude": 0.34,
    })

    return write_pitch_fixture(base_dir, f"chromatic_{start_note}_to_{top_note}_144bpm_32nd", segments)


def create_note_rest_fixture(base_dir: Path) -> dict[str, object]:
    notation = """
T: Articulated Notes With Rests
L: 1/32
Q: 1/4=144
A: 0.34

A,3@0.18 z3 C3@0.32 z3 E3@0.5 z3 G3@0.72 z3
"""
    return write_stimulus_fixture(base_dir, "articulated_notes_with_rests_144bpm", parse_stimulus_notation(notation))


def create_slur_fixture(base_dir: Path, start_midi: int = 60, middle_midi: int = 67, end_midi: int = 64) -> dict[str, object]:
    start_note = note_name(start_midi)
    middle_note = note_name(middle_midi)
    end_note = note_name(end_midi)
    abc_start = "C"
    abc_middle = "G"
    abc_end = "E"
    notation = f"""
T: Slur {start_note} to {middle_note} to {end_note}
L: 1/32
Q: 1/4=144

{abc_start}4@0.34 ~{abc_start}->{abc_middle}:4@0.36 {abc_middle}4@0.36 ~{abc_middle}->{abc_end}:4@0.35 {abc_end}4@0.33
"""
    return write_stimulus_fixture(base_dir, f"slur_{start_note}_to_{middle_note}_to_{end_note}_144bpm", parse_stimulus_notation(notation))