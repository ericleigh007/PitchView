import json
import importlib.util
import math
import statistics
import shutil
import tempfile
import subprocess
import sys
import unittest
import wave
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "preprocess_media.py"
SPEC = importlib.util.spec_from_file_location("pitchview_preprocess_media", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class PreprocessMediaTests(unittest.TestCase):
    def test_check_backend_reports_core_fields(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "check-backend"],
            check=True,
            capture_output=True,
            text=True,
        )

        payload = json.loads(result.stdout)

        self.assertIn("ffmpeg_available", payload)
        self.assertIn("available_stem_models", payload)
        self.assertIn("available_pitch_models", payload)
        self.assertTrue(payload["python_executable"])

    def test_repair_pitch_json_levels_and_deglitches(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "pitch.json"
            output_path = Path(temp_dir) / "pitch-fixed.json"
            input_path.write_text(json.dumps({
                "amplitudes": [0.03, 0.4, 0.05],
                "pitch_hz": [220.0, 440.0, 221.0],
                "confidence": [0.99, 0.2, 0.99]
            }), encoding="utf-8")

            subprocess.run(
                [sys.executable, str(SCRIPT), "repair-pitch-json", str(input_path), str(output_path)],
                check=True,
                capture_output=True,
                text=True,
            )

            payload = json.loads(output_path.read_text(encoding="utf-8"))

            self.assertGreater(payload["amplitudes"][0], 0.03)
            self.assertLess(payload["pitch_hz"][1], 230)
            self.assertGreater(payload["pitch_hz"][1], 220)

    def test_compute_amplitude_envelope_normalizes_peaks(self) -> None:
        envelope = MODULE.compute_amplitude_envelope([0.0, 0.2, 0.5, 1.0, 0.25], bucket_count=3)

        self.assertEqual(max(envelope), 1.0)
        self.assertGreaterEqual(min(envelope), 0.0)

    def test_compute_pitch_contour_tracks_constant_tone(self) -> None:
        sample_rate = 44100
        frequency = 220.0
        samples = [math.sin((2 * math.pi * frequency * index) / sample_rate) * (0.2 if index % 4000 < 2000 else 0.8) for index in range(sample_rate)]
        leveled = MODULE.level_sample_series(samples)
        contour, confidence = MODULE.compute_pitch_contour(leveled, sample_rate, point_count=20)
        detected = [value for value in contour if value > 0]

        self.assertGreater(len(detected), 5)
        average = sum(detected) / len(detected)
        self.assertGreater(average, 210)
        self.assertLess(average, 230)
        self.assertEqual(len(contour), len(confidence))

    def test_compute_pitch_contour_preserves_pitch_modulation(self) -> None:
        sample_rate = 44100
        duration_seconds = 2
        sample_count = sample_rate * duration_seconds
        samples = []

        for index in range(sample_count):
            time_seconds = index / sample_rate
            vibrato_hz = 12.0 * math.sin(2 * math.pi * 7 * time_seconds)
            instantaneous_frequency = 220.0 + vibrato_hz
            samples.append(math.sin((2 * math.pi * instantaneous_frequency * index) / sample_rate) * 0.45)

        leveled = MODULE.level_sample_series(samples)
        contour, _ = MODULE.compute_pitch_contour(leveled, sample_rate, point_count=96)
        detected = [value for value in contour if value > 0]

        self.assertGreater(len(detected), 40)
        self.assertGreater(max(detected) - min(detected), 10.0)

    def test_prepare_pitch_detection_samples_preserves_sample_count(self) -> None:
        sample_rate = 44100
        samples = [math.sin((2 * math.pi * 220.0 * index) / sample_rate) for index in range(sample_rate // 2)]

        prepared = MODULE.prepare_pitch_detection_samples(samples, sample_rate)

        self.assertEqual(len(prepared), len(samples))

    def test_compute_pitch_contour_prefers_fundamental_over_strong_second_harmonic(self) -> None:
        sample_rate = 44100
        duration_seconds = 2
        sample_count = sample_rate * duration_seconds
        samples = []

        for index in range(sample_count):
            time_seconds = index / sample_rate
            fundamental = 0.12 * math.sin(2 * math.pi * 220.0 * time_seconds)
            second_harmonic = 0.85 * math.sin(2 * math.pi * 440.0 * time_seconds)
            third_harmonic = 0.18 * math.sin(2 * math.pi * 660.0 * time_seconds)
            samples.append(fundamental + second_harmonic + third_harmonic)

        leveled = MODULE.level_sample_series(samples)
        prepared = MODULE.prepare_pitch_detection_samples(leveled, sample_rate)
        contour, confidence = MODULE.compute_pitch_contour(prepared, sample_rate, point_count=96)
        detected = [value for value in contour if value > 0]

        self.assertEqual(len(contour), len(confidence))
        self.assertEqual(len(contour), 96)
        self.assertGreater(len(detected), 40)
        average = sum(detected) / len(detected)
        self.assertGreater(average, 210)
        self.assertLess(average, 230)

    @unittest.skipUnless(
        MODULE.torchcrepe_is_available() and MODULE.torch_cuda_is_available(),
        "torchcrepe with CUDA is required for torch-based pitch contour testing",
    )
    def test_compute_pitch_contour_tracks_constant_tone_with_torch_cuda(self) -> None:
        sample_rate = 44100
        frequency = 220.0
        samples = [math.sin((2 * math.pi * frequency * index) / sample_rate) * 0.35 for index in range(sample_rate)]
        leveled = MODULE.level_sample_series(samples)
        contour, confidence = MODULE.compute_pitch_contour(leveled, sample_rate, point_count=48, pitch_model="torch-cuda")
        detected = [value for value in contour if value > 0]

        self.assertGreater(len(detected), 16)
        self.assertGreater(statistics.median(detected), 216)
        self.assertLess(statistics.median(detected), 224)
        self.assertEqual(len(contour), len(confidence))
        self.assertGreater(statistics.mean(confidence), 0.3)

    def test_resolve_pitch_model_uses_torch_cuda_when_available(self) -> None:
        requested, used = MODULE.resolve_pitch_model("torch-cuda")

        self.assertEqual(requested, "torch-cuda")
        if MODULE.torchcrepe_is_available() and MODULE.torch_cuda_is_available():
            self.assertEqual(used, "torch-cuda")
        else:
            self.assertEqual(used, "yin")

    def test_resolve_processing_device_prefers_cuda_when_available(self) -> None:
        requested, used = MODULE.resolve_processing_device("auto")

        self.assertEqual(requested, "auto")
        if MODULE.torch_cuda_is_available():
            self.assertEqual(used, "cuda")
        else:
            self.assertEqual(used, "cpu")

    def test_resolve_pitch_model_falls_back_to_yin_when_processing_device_is_cpu(self) -> None:
        with mock.patch.object(MODULE, "torchcrepe_is_available", return_value=True), \
            mock.patch.object(MODULE, "torch_cuda_is_available", return_value=True):
            requested, used = MODULE.resolve_pitch_model("torch-cuda", processing_device="cpu")

        self.assertEqual(requested, "torch-cuda")
        self.assertEqual(used, "yin")

    def test_repair_pitch_dropouts_fills_short_unvoiced_gap(self) -> None:
        contour = [220.0, 221.0, 0.0, 222.0, 223.0]
        confidence = [0.95, 0.95, 0.2, 0.95, 0.95]

        repaired = MODULE.repair_pitch_dropouts(contour, confidence)

        self.assertGreater(repaired[2], 220.0)
        self.assertLess(repaired[2], 223.0)

    def test_suppress_octave_glitches_repairs_isolated_harmonic_jump(self) -> None:
        contour = [220.0, 221.0, 442.0, 222.0, 223.0]
        confidence = [0.95, 0.95, 0.45, 0.95, 0.95]

        repaired = MODULE.suppress_octave_glitches(contour, confidence)

        self.assertGreater(repaired[2], 220.0)
        self.assertLess(repaired[2], 223.0)

    def test_choose_pitch_analysis_source_prefers_cached_vocals(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "analysis"
            output_dir.mkdir(parents=True, exist_ok=True)
            input_path = Path(temp_dir) / "clip.mp4"
            input_path.write_bytes(b"placeholder")
            vocals_path = output_dir / "vocals.wav"
            vocals_path.write_bytes(b"vocals")

            path, source_kind = MODULE.choose_pitch_analysis_source(input_path, output_dir)

            self.assertEqual(path, vocals_path)
            self.assertEqual(source_kind, "vocals")

    def test_analyze_media_uses_vocals_for_pitch_when_stems_are_present(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "clip.mp4"
            output_dir = Path(temp_dir) / "analysis"
            input_path.write_bytes(b"placeholder")
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / "vocals.wav").write_bytes(b"vocals")

            normalized_inputs: list[Path] = []

            def fake_normalize(input_media: Path, output_media: Path) -> dict[str, object]:
                normalized_inputs.append(input_media)
                output_media.write_bytes(b"normalized")
                return {"status": "completed"}

            def fake_playback_audio(input_media: Path, output_media: Path) -> dict[str, object]:
                output_media.write_bytes(b"playback")
                return {"status": "completed"}

            def fake_display_video(input_media: Path, output_media: Path) -> dict[str, object]:
                output_media.write_bytes(b"display")
                return {"status": "completed"}

            with mock.patch.object(MODULE, "require_backend_tools", return_value=MODULE.detect_backend()), \
                mock.patch.object(MODULE, "separate_stems", return_value={"status": "completed", "sources": []}), \
                mock.patch.object(MODULE, "create_playback_audio", side_effect=fake_playback_audio), \
                mock.patch.object(MODULE, "create_display_video", side_effect=fake_display_video), \
                mock.patch.object(MODULE, "normalize_media", side_effect=fake_normalize), \
                mock.patch.object(MODULE, "load_wav_samples", return_value=([0.0, 0.2, 0.4, 0.2] * 4096, 44100)), \
                mock.patch.object(MODULE, "probe_media", return_value={"streams": [{"codec_type": "video"}], "format": {"duration": "1.0"}}):
                payload = MODULE.analyze_media(input_path, output_dir, stem_model="HTDemucs FT", separate=True)

            self.assertEqual(normalized_inputs[0], output_dir / "vocals.wav")
            self.assertEqual(payload["analysis_source"]["kind"], "vocals")

    def test_analyze_media_builds_amplitude_envelope_from_leveled_pitch_input(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "clip.wav"
            output_dir = Path(temp_dir) / "analysis"
            input_path.write_bytes(b"placeholder")
            output_dir.mkdir(parents=True, exist_ok=True)

            raw_samples = [0.01, 0.2, 0.05, 0.4] * 4096
            leveled_samples = [0.1, 0.3, 0.15, 0.6] * 4096

            with mock.patch.object(MODULE, "require_backend_tools", return_value=MODULE.detect_backend()), \
                mock.patch.object(MODULE, "create_playback_audio", return_value={"status": "completed"}), \
                mock.patch.object(MODULE, "normalize_media", return_value={"status": "completed"}), \
                mock.patch.object(MODULE, "load_wav_samples", return_value=(raw_samples, 44100)), \
                mock.patch.object(MODULE, "probe_media", return_value={"streams": [], "format": {"duration": "1.0"}}), \
                mock.patch.object(MODULE, "level_sample_series", return_value=leveled_samples) as level_mock, \
                mock.patch.object(MODULE, "compute_amplitude_envelope", return_value=[0.2, 0.4, 1.0]) as envelope_mock, \
                mock.patch.object(MODULE, "compute_pitch_contour", return_value=([220.0, 221.0], [0.9, 0.9])):
                payload = MODULE.analyze_media(input_path, output_dir, separate=False)

            level_mock.assert_called_once_with(raw_samples)
            expected_point_count = MODULE.choose_pitch_point_count(leveled_samples, 44100)
            envelope_mock.assert_called_once_with(leveled_samples, expected_point_count)
            self.assertEqual(payload["amplitudes"], [0.2, 0.4, 1.0])

    def test_analyze_media_passes_processing_device_to_stem_and_pitch_stages(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "clip.wav"
            output_dir = Path(temp_dir) / "analysis"
            input_path.write_bytes(b"placeholder")
            output_dir.mkdir(parents=True, exist_ok=True)

            with mock.patch.object(MODULE, "require_backend_tools", return_value=MODULE.detect_backend()), \
                mock.patch.object(MODULE, "create_playback_audio", return_value={"status": "completed"}), \
                mock.patch.object(MODULE, "normalize_media", return_value={"status": "completed"}), \
                mock.patch.object(MODULE, "load_wav_samples", return_value=([0.1, 0.2, 0.3, 0.2] * 4096, 44100)), \
                mock.patch.object(MODULE, "probe_media", return_value={"streams": [], "format": {"duration": "1.0"}}), \
                mock.patch.object(MODULE, "level_sample_series", side_effect=lambda samples: samples), \
                mock.patch.object(MODULE, "compute_amplitude_envelope", return_value=[0.2, 0.4, 1.0]), \
                mock.patch.object(MODULE, "separate_stems", return_value={"status": "completed", "sources": []}) as stem_mock, \
                mock.patch.object(MODULE, "compute_pitch_contour", return_value=([220.0, 221.0], [0.9, 0.9])) as pitch_mock:
                payload = MODULE.analyze_media(
                    input_path,
                    output_dir,
                    stem_model="HTDemucs FT",
                    separate=True,
                    pitch_model="yin",
                    pitch_source="vocals",
                    processing_device="gpu",
                )

            stem_mock.assert_called_once_with(
                input_path,
                output_dir,
                "HTDemucs FT",
                bypass_cache=False,
                processing_device="gpu",
            )
            self.assertEqual(pitch_mock.call_args.kwargs["processing_device"], "gpu")
            self.assertEqual(payload["processing_device_requested"], "gpu")

    def test_analyze_media_returns_cached_payload_when_outputs_are_fresh(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "clip.wav"
            output_dir = Path(temp_dir) / "analysis"
            output_dir.mkdir(parents=True, exist_ok=True)
            input_path.write_bytes(b"source")

            playback_audio = output_dir / "playback.wav"
            normalized_wav = output_dir / "normalized-original-yin.wav"
            analysis_json = output_dir / "analysis-original-yin.json"
            playback_audio.write_bytes(b"playback")
            normalized_wav.write_bytes(b"normalized")
            cached_payload = {
                "input": str(input_path),
                "analysis_cache_version": MODULE.ANALYSIS_CACHE_VERSION,
                "analysis_source": {"kind": "original", "path": str(input_path)},
                "pitch_model_requested": "yin",
                "pitch_model_used": "yin",
                "normalized_audio": str(normalized_wav),
                "analysis_json": str(analysis_json),
                "sources": [{"kind": "original", "label": "Original", "path": str(playback_audio)}],
                "amplitudes": [0.2],
                "pitch_hz": [220.0],
                "confidence": [0.9],
                "note": "cached"
            }
            analysis_json.write_text(json.dumps(cached_payload), encoding="utf-8")

            with mock.patch.object(MODULE, "probe_media", return_value={"streams": [], "format": {"duration": "1.0"}}), \
                mock.patch.object(MODULE, "create_playback_audio") as playback_mock, \
                mock.patch.object(MODULE, "normalize_media") as normalize_mock:
                payload = MODULE.analyze_media(input_path, output_dir, separate=False)

            self.assertEqual(payload["cache_status"], "hit")
            playback_mock.assert_not_called()
            normalize_mock.assert_not_called()

    @unittest.skipUnless(
        MODULE.detect_backend().ffmpeg_available and MODULE.detect_backend().ffprobe_available,
        "FFmpeg and ffprobe are required for CLI analyze-media integration",
    )
    def test_analyze_media_cli_generates_overlay_payload_for_wav_input(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "tone.wav"
            output_dir = Path(temp_dir) / "analysis"
            sample_rate = 44100
            sample_count = sample_rate

            with wave.open(str(input_path), "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(sample_rate)
                frames = bytearray()
                for index in range(sample_count):
                    sample = int(math.sin((2 * math.pi * 220.0 * index) / sample_rate) * 16000)
                    frames.extend(int(sample).to_bytes(2, byteorder="little", signed=True))
                wav_file.writeframes(bytes(frames))

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "analyze-media", str(input_path), str(output_dir)],
                check=True,
                capture_output=True,
                text=True,
            )

            payload = json.loads(result.stdout)

            self.assertEqual(payload["analysis_source"]["kind"], "original")
            self.assertGreater(len(payload["amplitudes"]), 8)
            self.assertGreater(len([value for value in payload["pitch_hz"] if value > 0]), 5)
            self.assertEqual(payload["analysis_cache_version"], MODULE.ANALYSIS_CACHE_VERSION)

    @unittest.skipUnless(
        MODULE.detect_backend().ffmpeg_available
        and MODULE.detect_backend().ffprobe_available
        and MODULE.torchcrepe_is_available()
        and MODULE.torch_cuda_is_available(),
        "FFmpeg, ffprobe, torchcrepe, and CUDA are required for torch-cuda CLI integration",
    )
    def test_analyze_media_cli_generates_overlay_payload_for_torch_cuda_input(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "tone.wav"
            output_dir = Path(temp_dir) / "analysis"
            sample_rate = 44100
            sample_count = sample_rate * 2

            with wave.open(str(input_path), "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(sample_rate)
                frames = bytearray()
                for index in range(sample_count):
                    sample = int(math.sin((2 * math.pi * 220.0 * index) / sample_rate) * 16000)
                    frames.extend(int(sample).to_bytes(2, byteorder="little", signed=True))
                wav_file.writeframes(bytes(frames))

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "analyze-media", str(input_path), str(output_dir), "--pitch-model", "torch-cuda"],
                check=True,
                capture_output=True,
                text=True,
            )

            payload = json.loads(result.stdout)
            detected = [value for value in payload["pitch_hz"] if value > 0]

            self.assertEqual(payload["pitch_model_requested"], "torch-cuda")
            self.assertEqual(payload["pitch_model_used"], "torch-cuda")
            self.assertEqual(payload["processing_device_used"], "cuda")
            self.assertGreater(len(detected), 24)
            self.assertGreater(statistics.median(detected), 216)
            self.assertLess(statistics.median(detected), 224)
            self.assertIn("torch-cuda pitch detection", payload["note"])

    @unittest.skipUnless(
        MODULE.detect_backend().ffmpeg_available
        and MODULE.detect_backend().ffprobe_available
        and MODULE.detect_backend().demucs_available,
        "FFmpeg, ffprobe, and demucs are required for end-to-end stem/caching integration",
    )
    def test_analyze_media_cli_separates_stems_caches_outputs_and_writes_contours_before_playback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "clip.mp4"
            output_dir = Path(temp_dir) / "analysis"
            backend = MODULE.detect_backend()

            subprocess.run([
                backend.ffmpeg_path or "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=320x240:d=1.5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=220:sample_rate=44100:duration=1.5",
                "-shortest",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                str(input_path),
            ], check=True, capture_output=True, text=True)

            first_result = subprocess.run(
                [sys.executable, str(SCRIPT), "analyze-media", str(input_path), str(output_dir), "--separate-stems", "--stem-model", "HTDemucs FT"],
                check=True,
                capture_output=True,
                text=True,
            )
            first_payload = json.loads(first_result.stdout)

            self.assertEqual(first_payload["cache_status"], "miss")
            self.assertEqual(first_payload["analysis_source"]["kind"], "vocals")
            self.assertEqual(first_payload["separation"]["status"], "completed")
            self.assertTrue((output_dir / "playback.wav").exists())
            self.assertTrue((output_dir / "display.mp4").exists())
            self.assertTrue((output_dir / "normalized-vocals-yin.wav").exists())
            self.assertTrue((output_dir / "analysis-vocals-yin.json").exists())
            self.assertTrue((output_dir / "vocals.wav").exists())
            self.assertTrue((output_dir / "other.wav").exists())
            self.assertGreater(len(first_payload["amplitudes"]), 8)
            self.assertGreater(len([value for value in first_payload["pitch_hz"] if value > 0]), 5)
            self.assertEqual(first_payload["analysis_cache_version"], MODULE.ANALYSIS_CACHE_VERSION)
            self.assertIn("Desktop analysis generated", first_payload["note"])
            self.assertTrue(any(source["kind"] == "vocals" for source in first_payload["sources"]))
            self.assertTrue(any(source["kind"] == "other" for source in first_payload["sources"]))
            self.assertIn("phase: stem-separating started", first_result.stderr)
            self.assertIn("phase: pitch-caching completed", first_result.stderr)

            second_result = subprocess.run(
                [sys.executable, str(SCRIPT), "analyze-media", str(input_path), str(output_dir), "--separate-stems", "--stem-model", "HTDemucs FT"],
                check=True,
                capture_output=True,
                text=True,
            )
            second_payload = json.loads(second_result.stdout)

            self.assertEqual(second_payload["cache_status"], "hit")
            self.assertEqual(second_payload["playback_audio"], str(output_dir / "playback.wav"))
            self.assertEqual(second_payload["display_video"], str(output_dir / "display.mp4"))
            self.assertIn("phase: pitch-caching cached", second_result.stderr)

    def test_separate_stems_uses_cached_outputs_when_present(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            media_path = Path(temp_dir) / "clip.mp4"
            output_dir = Path(temp_dir) / "analysis"
            output_dir.mkdir(parents=True, exist_ok=True)
            media_path.write_bytes(b"placeholder")
            (output_dir / "vocals.wav").write_bytes(b"vocals")
            (output_dir / "other.wav").write_bytes(b"other")

            payload = MODULE.separate_stems(media_path, output_dir, "HTDemucs FT")

            self.assertEqual(payload["status"], "cached")
            self.assertEqual(len(payload["sources"]), 2)


if __name__ == "__main__":
    unittest.main()
