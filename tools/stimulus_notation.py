from __future__ import annotations

import json
import math
import re
import wave
from dataclasses import dataclass
from pathlib import Path


NOTE_PATTERN = re.compile(r"^(?P<accidental>\^|_|=)?(?P<letter>[A-Ga-gz])(?P<octave>[,']*)(?P<length>\d+)?(?:@(?P<amplitude>\d+(?:\.\d+)?))?$")
SLUR_PATTERN = re.compile(
    r"^~(?P<start>[^\s:]+)->(?P<end>[^\s:]+):(?P<length>\d+)(?:@(?P<amplitude>\d+(?:\.\d+)?))?$"
)

DEFAULT_SAMPLE_RATE = 44100
DEFAULT_UNIT_NOTE = 32
DEFAULT_BPM = 144
DEFAULT_AMPLITUDE = 0.34


@dataclass(frozen=True)
class StimulusSettings:
    title: str
    unit_note: int
    bpm: int
    sample_rate: int
    default_amplitude: float


@dataclass(frozen=True)
class StimulusSegment:
    segment_type: str
    label: str
    note: str
    midi: int
    frequency_hz: float
    start_frequency_hz: float
    end_frequency_hz: float
    duration_seconds: float
    amplitude: float


@dataclass(frozen=True)
class ParsedStimulus:
    settings: StimulusSettings
    segments: list[StimulusSegment]


def midi_to_frequency(midi: int) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def note_name(midi: int) -> str:
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    return f"{names[midi % 12]}{(midi // 12) - 1}"


def unit_duration_seconds(unit_note: int, bpm: int) -> float:
    quarter_seconds = 60.0 / bpm
    return quarter_seconds * (4.0 / unit_note)


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
    sample_rate: int,
    apply_segment_fades: bool,
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


def render_segment(segment: StimulusSegment, sample_rate: int) -> list[float]:
    sample_count = max(1, round(segment.duration_seconds * sample_rate))

    if segment.segment_type == "rest":
        return [0.0] * sample_count

    if segment.segment_type == "slur":
        start_log = math.log2(max(segment.start_frequency_hz, 1e-6))
        end_log = math.log2(max(segment.end_frequency_hz, 1e-6))
        frequencies = [
            2.0 ** (start_log + ((end_log - start_log) * index / max(sample_count - 1, 1)))
            for index in range(sample_count)
        ]
        return synthesize_frequency_curve(frequencies, segment.amplitude, sample_rate, apply_segment_fades=False)

    return synthesize_frequency_curve([segment.frequency_hz] * sample_count, segment.amplitude, sample_rate, apply_segment_fades=True)


def parse_abc_note(token: str) -> tuple[int, str]:
    match = NOTE_PATTERN.match(token)
    if not match:
        raise ValueError(f"Unsupported note token '{token}'.")

    accidental = match.group("accidental") or ""
    letter = match.group("letter")
    octave = match.group("octave") or ""

    if letter == "z":
        return -1, "rest"

    base_midi = {
        "C": 60,
        "D": 62,
        "E": 64,
        "F": 65,
        "G": 67,
        "A": 69,
        "B": 71,
    }[letter.upper()]

    if letter.islower():
        base_midi += 12

    for marker in octave:
        if marker == ",":
            base_midi -= 12
        elif marker == "'":
            base_midi += 12

    if accidental == "^":
        base_midi += 1
    elif accidental == "_":
        base_midi -= 1

    return base_midi, note_name(base_midi)


def parse_headers(lines: list[str]) -> tuple[StimulusSettings, list[str]]:
    title = "Stimulus"
    unit_note = DEFAULT_UNIT_NOTE
    bpm = DEFAULT_BPM
    sample_rate = DEFAULT_SAMPLE_RATE
    default_amplitude = DEFAULT_AMPLITUDE
    body_lines: list[str] = []

    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("%"):
            continue

        if ":" in line and len(line.split(":", 1)[0]) <= 2:
            key, value = [part.strip() for part in line.split(":", 1)]
            if key == "T":
                title = value
            elif key == "L":
                unit_note = int(value.split("/")[-1])
            elif key == "Q":
                bpm = int(value.split("=")[-1])
            elif key == "P":
                sample_rate = int(value)
            elif key == "A":
                default_amplitude = float(value)
            continue

        body_lines.append(line)

    return StimulusSettings(title, unit_note, bpm, sample_rate, default_amplitude), body_lines


def parse_stimulus_notation(notation: str) -> ParsedStimulus:
    settings, body_lines = parse_headers(notation.splitlines())
    unit_seconds = unit_duration_seconds(settings.unit_note, settings.bpm)
    segments: list[StimulusSegment] = []

    for line in body_lines:
        for raw_token in line.replace("|", " ").split():
            slur_match = SLUR_PATTERN.match(raw_token)
            if slur_match:
                start_midi, start_name = parse_abc_note(slur_match.group("start"))
                end_midi, end_name = parse_abc_note(slur_match.group("end"))
                length_units = int(slur_match.group("length") or 1)
                amplitude = float(slur_match.group("amplitude") or settings.default_amplitude)
                segments.append(StimulusSegment(
                    segment_type="slur",
                    label=f"slur-{start_name}-to-{end_name}",
                    note=f"{start_name}->{end_name}",
                    midi=end_midi,
                    frequency_hz=midi_to_frequency(end_midi),
                    start_frequency_hz=midi_to_frequency(start_midi),
                    end_frequency_hz=midi_to_frequency(end_midi),
                    duration_seconds=unit_seconds * length_units,
                    amplitude=amplitude,
                ))
                continue

            note_match = NOTE_PATTERN.match(raw_token)
            if not note_match:
                raise ValueError(f"Unsupported stimulus token '{raw_token}'.")

            midi, label = parse_abc_note(f"{note_match.group('accidental') or ''}{note_match.group('letter')}{note_match.group('octave') or ''}")
            length_units = int(note_match.group("length") or 1)
            amplitude = float(note_match.group("amplitude") or settings.default_amplitude)
            segment_type = "rest" if midi < 0 else "tone"
            frequency_hz = 0.0 if midi < 0 else midi_to_frequency(midi)
            segments.append(StimulusSegment(
                segment_type=segment_type,
                label=(f"rest-{len(segments) + 1}" if midi < 0 else f"note-{label}"),
                note=label,
                midi=midi,
                frequency_hz=frequency_hz,
                start_frequency_hz=frequency_hz,
                end_frequency_hz=frequency_hz,
                duration_seconds=unit_seconds * length_units,
                amplitude=0.0 if midi < 0 else amplitude,
            ))

    return ParsedStimulus(settings=settings, segments=segments)


def write_wav(path: Path, samples: list[float], sample_rate: int) -> None:
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


def write_stimulus_fixture(base_dir: Path, name: str, parsed: ParsedStimulus) -> dict[str, object]:
    base_dir.mkdir(parents=True, exist_ok=True)
    wav_path = base_dir / f"{name}.wav"
    metadata_path = base_dir / f"{name}.json"

    samples: list[float] = []
    timeline_segments: list[dict[str, object]] = []
    current_time = 0.0
    for index, segment in enumerate(parsed.segments):
        segment_samples = render_segment(segment, parsed.settings.sample_rate)
        samples.extend(segment_samples)
        start_time = current_time
        current_time += segment.duration_seconds
        timeline_segments.append({
            "index": index,
            "segment_type": segment.segment_type,
            "label": segment.label,
            "midi": segment.midi,
            "note": segment.note,
            "frequency_hz": round(segment.frequency_hz, 6),
            "start_frequency_hz": round(segment.start_frequency_hz, 6),
            "end_frequency_hz": round(segment.end_frequency_hz, 6),
            "duration_seconds": round(segment.duration_seconds, 6),
            "amplitude": round(segment.amplitude, 6),
            "start_time_seconds": round(start_time, 6),
            "end_time_seconds": round(current_time, 6),
        })

    write_wav(wav_path, samples, parsed.settings.sample_rate)
    payload = {
        "name": name,
        "title": parsed.settings.title,
        "sample_rate": parsed.settings.sample_rate,
        "wav_path": str(wav_path),
        "metadata_path": str(metadata_path),
        "duration_seconds": round(current_time, 6),
        "segments": timeline_segments,
    }
    metadata_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload