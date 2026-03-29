import importlib.util
import json
import math
import shutil
import statistics
import sys
import tempfile
from pathlib import Path

from tests.pitch_test_support import (
    create_chromatic_run_fixture,
    create_fixed_pitch_level_fixtures,
    create_note_rest_fixture,
    create_slur_fixture,
)


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "preprocess_media.py"
ARTIFACT_ROOT = ROOT / ".tmp" / "test-artifacts" / "pitch"
REPORT_ROOT = ARTIFACT_ROOT / "reports"


def load_preprocess_module():
    spec = importlib.util.spec_from_file_location("pitchview_preprocess_media_harness", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def semitone_error(actual_hz: float, expected_hz: float) -> float:
    return abs(12.0 * math.log2(actual_hz / expected_hz))


def contour_points_with_time(contour: list[float], duration_seconds: float) -> list[dict[str, float]]:
    if not contour:
        return []

    denominator = max(len(contour) - 1, 1)
    return [
        {
            "time_seconds": round((duration_seconds * index) / denominator, 6),
            "pitch_hz": round(float(value), 6),
        }
        for index, value in enumerate(contour)
    ]


def summarize_segment(points: list[dict[str, float]], segment: dict[str, object]) -> dict[str, object]:
    start_time = float(segment["start_time_seconds"])
    end_time = float(segment["end_time_seconds"])
    duration = end_time - start_time
    margin = min(0.0125, duration * 0.22)
    segment_type = str(segment.get("segment_type", "tone"))
    voiced = [
        point["pitch_hz"]
        for point in points
        if start_time + margin <= point["time_seconds"] <= end_time - margin and point["pitch_hz"] > 0
    ]

    if segment_type == "rest":
        rest_margin = min(0.04, duration * 0.4)
        sampled_points = [
            point
            for point in points
            if start_time + rest_margin <= point["time_seconds"] <= end_time - rest_margin
        ]
        voiced_points = len([point for point in sampled_points if point["pitch_hz"] > 0])
        sampled_count = len(sampled_points)
        voiced_ratio = (voiced_points / sampled_count) if sampled_count else 0.0
        return {
            "label": segment["label"],
            "segment_type": segment_type,
            "expected_note": segment["note"],
            "expected_hz": 0.0,
            "detected_hz": 0.0,
            "voiced_points": voiced_points,
            "sampled_points": sampled_count,
            "voiced_ratio": round(voiced_ratio, 6),
            "semitone_error": None,
        }

    if segment_type == "slur":
        sampled_points = [
            point
            for point in points
            if start_time + margin <= point["time_seconds"] <= end_time - margin and point["pitch_hz"] > 0
        ]
        start_frequency_hz = float(segment["start_frequency_hz"])
        end_frequency_hz = float(segment["end_frequency_hz"])
        start_log = math.log2(max(start_frequency_hz, 1e-6))
        end_log = math.log2(max(end_frequency_hz, 1e-6))
        errors = []

        for point in sampled_points:
            relative_progress = (point["time_seconds"] - start_time) / max(duration, 1e-6)
            expected_hz = 2.0 ** (start_log + (end_log - start_log) * relative_progress)
            errors.append(semitone_error(point["pitch_hz"], expected_hz))

        return {
            "label": segment["label"],
            "segment_type": segment_type,
            "expected_note": segment["note"],
            "expected_hz": round(end_frequency_hz, 6),
            "detected_hz": round(statistics.median(voiced), 6) if voiced else 0.0,
            "voiced_points": len(voiced),
            "sampled_points": len(sampled_points),
            "mean_semitone_error": round(statistics.mean(errors), 6) if errors else None,
            "max_semitone_error": round(max(errors), 6) if errors else None,
            "semitone_error": round(statistics.median(errors), 6) if errors else None,
        }

    if not voiced:
        return {
            "label": segment["label"],
            "segment_type": segment_type,
            "expected_note": segment["note"],
            "expected_hz": segment["frequency_hz"],
            "detected_hz": 0.0,
            "voiced_points": 0,
            "semitone_error": None,
        }

    detected_hz = statistics.median(voiced)
    expected_hz = float(segment["frequency_hz"])
    return {
        "label": segment["label"],
        "segment_type": segment_type,
        "expected_note": segment["note"],
        "expected_hz": round(expected_hz, 6),
        "detected_hz": round(detected_hz, 6),
        "voiced_points": len(voiced),
        "semitone_error": round(semitone_error(detected_hz, expected_hz), 6),
    }


def clear_pitch_artifacts(artifact_root: Path = ARTIFACT_ROOT) -> None:
    if artifact_root.exists():
        shutil.rmtree(artifact_root)
    artifact_root.mkdir(parents=True, exist_ok=True)


def write_pitch_artifact(
    fixture: dict[str, object],
    requested_model: str,
    used_model: str,
    contour: list[float],
    confidence: list[float],
    summary: list[dict[str, object]],
    artifact_root: Path = ARTIFACT_ROOT,
) -> Path:
    artifact_root.mkdir(parents=True, exist_ok=True)
    artifact_path = artifact_root / f"{fixture['name']}-{requested_model}.json"
    payload = {
        "fixture": fixture["name"],
        "requested_model": requested_model,
        "used_model": used_model,
        "duration_seconds": fixture["duration_seconds"],
        "metadata_path": fixture["metadata_path"],
        "contour_points": contour_points_with_time(contour, float(fixture["duration_seconds"])),
        "confidence": [round(float(value), 6) for value in confidence],
        "segment_summary": summary,
    }
    artifact_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return artifact_path


def analyze_fixture(
    fixture: dict[str, object],
    requested_model: str,
    preprocess_module,
    artifact_root: Path = ARTIFACT_ROOT,
) -> dict[str, object]:
    metadata = json.loads(Path(fixture["metadata_path"]).read_text(encoding="utf-8"))
    samples, sample_rate = preprocess_module.load_wav_samples(Path(fixture["wav_path"]))
    leveled_samples = preprocess_module.level_sample_series(samples)
    point_count = max(160, round(float(metadata["duration_seconds"]) * 64))
    _, used_model = preprocess_module.resolve_pitch_model(requested_model)
    contour, confidence = preprocess_module.compute_pitch_contour(
        leveled_samples,
        sample_rate,
        point_count=point_count,
        pitch_model=requested_model,
    )
    points = contour_points_with_time(contour, float(metadata["duration_seconds"]))
    summary = [summarize_segment(points, segment) for segment in metadata["segments"]]
    artifact_path = write_pitch_artifact(fixture, requested_model, used_model, contour, confidence, summary, artifact_root)
    return {
        "fixture": fixture,
        "metadata": metadata,
        "requested_model": requested_model,
        "used_model": used_model,
        "contour": contour,
        "confidence": confidence,
        "summary": summary,
        "artifact_path": artifact_path,
    }


def _format_float(value: float | None, digits: int = 3) -> str:
    if value is None:
        return "n/a"
    return f"{value:.{digits}f}"


def _mean_or_none(values: list[float]) -> float | None:
    return statistics.mean(values) if values else None


def generate_detector_report(
    requested_model: str,
    results: list[dict[str, object]],
    artifact_root: Path = ARTIFACT_ROOT,
    report_root: Path | None = None,
) -> Path:
    resolved_report_root = report_root or (artifact_root / "reports")
    resolved_report_root.mkdir(parents=True, exist_ok=True)
    report_path = resolved_report_root / f"{requested_model}.md"

    used_models = sorted({str(result["used_model"]) for result in results})
    fixed_results = [result for result in results if str(result["fixture"]["name"]).startswith("fixed_")]
    chromatic_results = [result for result in results if str(result["fixture"]["name"]).startswith("chromatic_")]
    articulation_results = [result for result in results if str(result["fixture"]["name"]).startswith("articulated_")]
    slur_results = [result for result in results if str(result["fixture"]["name"]).startswith("slur_")]

    fixed_rows: list[str] = []
    amplitude_errors: list[float] = []
    for result in sorted(fixed_results, key=lambda entry: str(entry["fixture"]["name"])):
        segment = result["metadata"]["segments"][0]
        summary = result["summary"][0]
        amplitude_errors.append(float(summary["semitone_error"]))
        fixed_rows.append(
            "| {fixture} | {amplitude:.2f} | {expected} | {detected} | {error} | {voiced} |".format(
                fixture=result["fixture"]["name"],
                amplitude=float(segment["amplitude"]),
                expected=_format_float(float(summary["expected_hz"])),
                detected=_format_float(float(summary["detected_hz"])),
                error=_format_float(float(summary["semitone_error"]), 4),
                voiced=int(summary["voiced_points"]),
            )
        )

    stable_hold_errors: list[float] = []
    motion_errors: list[float] = []
    articulation_note_errors: list[float] = []
    articulation_rest_voiced_ratios: list[float] = []
    slur_mean_errors: list[float] = []
    stable_hold_count = 0
    motion_count = 0
    for result in chromatic_results:
        for entry in result["summary"]:
            label = str(entry["label"])
            error = entry["semitone_error"]
            if error is None:
                continue
            if label.startswith("hold-"):
                stable_hold_errors.append(float(error))
                stable_hold_count += 1
            elif label.startswith("up-") or label.startswith("down-"):
                motion_errors.append(float(error))
                motion_count += 1

    for result in articulation_results:
        for entry in result["summary"]:
            segment_type = str(entry.get("segment_type", "tone"))
            if segment_type == "rest":
                articulation_rest_voiced_ratios.append(float(entry.get("voiced_ratio", 0.0)))
            elif entry["semitone_error"] is not None:
                articulation_note_errors.append(float(entry["semitone_error"]))

    for result in slur_results:
        for entry in result["summary"]:
            if str(entry.get("segment_type", "tone")) == "slur" and entry.get("mean_semitone_error") is not None:
                slur_mean_errors.append(float(entry["mean_semitone_error"]))

    lines = [
        f"# Pitch Detector Report: {requested_model}",
        "",
        f"- Requested model: `{requested_model}`",
        f"- Effective model(s): `{', '.join(used_models)}`",
        f"- Fixtures analyzed: `{len(results)}`",
        "",
        "## Pitch accuracy",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        f"| Fixed-pitch mean semitone error | {_format_float(_mean_or_none(amplitude_errors), 4)} |",
        f"| Chromatic hold mean semitone error | {_format_float(_mean_or_none(stable_hold_errors), 4)} |",
        f"| Chromatic motion mean semitone error | {_format_float(_mean_or_none(motion_errors), 4)} |",
        f"| Articulated note mean semitone error | {_format_float(_mean_or_none(articulation_note_errors), 4)} |",
        f"| Articulated rest mean voiced ratio | {_format_float(_mean_or_none(articulation_rest_voiced_ratios), 4)} |",
        f"| Slur mean semitone error | {_format_float(_mean_or_none(slur_mean_errors), 4)} |",
        f"| Stable hold segments analyzed | {stable_hold_count} |",
        f"| Motion segments analyzed | {motion_count} |",
        "",
        "## Pitch detection amplitude sensitivity",
        "",
        "| Fixture | Input amplitude | Expected Hz | Detected Hz | Semitone error | Voiced points |",
        "| --- | --- | --- | --- | --- | --- |",
        *fixed_rows,
        "",
        "## Notes",
        "",
    ]

    if len(used_models) == 1 and used_models[0] != requested_model:
        lines.append(f"- The requested detector currently falls back to `{used_models[0]}` in preprocessing.")
    else:
        lines.append("- The requested detector ran without fallback.")

    lines.append(f"- Artifact JSON files are stored under `{artifact_root}`.")
    lines.append("")

    report_path.write_text("\n".join(lines), encoding="utf-8")
    return report_path


def run_pitch_test_harness(artifact_root: Path = ARTIFACT_ROOT) -> dict[str, object]:
    preprocess_module = load_preprocess_module()
    clear_pitch_artifacts(artifact_root)
    report_root = artifact_root / "reports"

    results_by_model: dict[str, list[dict[str, object]]] = {
        requested_model: []
        for requested_model in preprocess_module.SUPPORTED_PITCH_MODELS
    }

    with tempfile.TemporaryDirectory() as temp_dir:
        fixture_root = Path(temp_dir)
        fixtures = [
            *create_fixed_pitch_level_fixtures(fixture_root),
            create_chromatic_run_fixture(fixture_root),
            create_note_rest_fixture(fixture_root),
            create_slur_fixture(fixture_root),
        ]
        for fixture in fixtures:
            for requested_model in preprocess_module.SUPPORTED_PITCH_MODELS:
                results_by_model[requested_model].append(
                    analyze_fixture(fixture, requested_model, preprocess_module, artifact_root)
                )

    report_paths = {
        requested_model: generate_detector_report(requested_model, model_results, artifact_root, report_root)
        for requested_model, model_results in results_by_model.items()
    }

    return {
        "preprocess_module": preprocess_module,
        "artifact_root": artifact_root,
        "report_root": report_root,
        "results_by_model": results_by_model,
        "report_paths": report_paths,
    }