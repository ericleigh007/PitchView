import json
import statistics
import unittest
from tests.pitch_harness import ARTIFACT_ROOT, run_pitch_test_harness


class PitchAccuracyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.harness = run_pitch_test_harness()
        cls.module = cls.harness["preprocess_module"]
        cls.results_by_model = cls.harness["results_by_model"]
        cls.report_paths = cls.harness["report_paths"]

    def get_result(self, requested_model: str, fixture_name: str) -> dict[str, object]:
        return next(
            result
            for result in self.results_by_model[requested_model]
            if str(result["fixture"]["name"]) == fixture_name
        )

    def test_fixed_pitch_outputs_are_stored_and_match_known_levels(self) -> None:
        fixed_fixture_names = ["fixed_A4_low", "fixed_A4_mid", "fixed_A4_high"]

        for fixture_name in fixed_fixture_names:
            for requested_model in self.module.SUPPORTED_PITCH_MODELS:
                result = self.get_result(requested_model, fixture_name)
                metadata = result["metadata"]
                contour = result["contour"]
                confidence = result["confidence"]
                summary = result["summary"]
                voiced = [value for value in contour if value > 0]
                expected_hz = float(metadata["segments"][0]["frequency_hz"])

                self.assertTrue(voiced, msg=f"Expected voiced contour points for {fixture_name} ({requested_model})")
                self.assertEqual(len(contour), len(confidence))
                expected_used_model = "torch-cuda" if requested_model == "torch-cuda" and self.module.torchcrepe_is_available() and self.module.torch_cuda_is_available() else "yin"
                self.assertEqual(result["used_model"], expected_used_model)
                self.assertGreaterEqual(summary[0]["voiced_points"], 8)
                self.assertLess(summary[0]["semitone_error"], 0.35)
                self.assertLess(abs(statistics.median(voiced) - expected_hz), 10.0)
                self.assertTrue(result["artifact_path"].exists())

    def test_chromatic_run_outputs_are_stored_and_match_known_pitch_segments(self) -> None:
        fixture_name = "chromatic_A3_to_A4_144bpm_32nd"

        for requested_model in self.module.SUPPORTED_PITCH_MODELS:
            result = self.get_result(requested_model, fixture_name)
            metadata = result["metadata"]
            contour = result["contour"]
            summary = result["summary"]
            voiced = [value for value in contour if value > 0]

            self.assertTrue(voiced, msg=f"Expected voiced contour points for chromatic fixture ({requested_model})")
            expected_used_model = "torch-cuda" if requested_model == "torch-cuda" and self.module.torchcrepe_is_available() and self.module.torch_cuda_is_available() else "yin"
            self.assertEqual(result["used_model"], expected_used_model)

            stable_holds = [
                entry for entry in summary
                if str(entry["label"]).startswith("hold-")
            ]
            motion_steps = [
                entry for entry in summary
                if str(entry["label"]).startswith("up-") or str(entry["label"]).startswith("down-")
            ]

            self.assertGreaterEqual(len(stable_holds), 3)
            self.assertGreaterEqual(len(motion_steps), 20)
            self.assertTrue(all(entry["voiced_points"] >= 8 for entry in stable_holds))
            self.assertTrue(all(entry["semitone_error"] is not None and entry["semitone_error"] < 0.3 for entry in stable_holds))
            self.assertTrue(all(entry["voiced_points"] >= 2 for entry in motion_steps))
            self.assertTrue(all(entry["semitone_error"] is not None and entry["semitone_error"] < 0.75 for entry in motion_steps))

            artifact_payload = json.loads(result["artifact_path"].read_text(encoding="utf-8"))
            self.assertEqual(artifact_payload["metadata_path"], result["fixture"]["metadata_path"])
            self.assertEqual(len(artifact_payload["segment_summary"]), len(metadata["segments"]))

    def test_articulated_notes_and_rests_match_known_stimulus(self) -> None:
        fixture_name = "articulated_notes_with_rests_144bpm"

        for requested_model in self.module.SUPPORTED_PITCH_MODELS:
            result = self.get_result(requested_model, fixture_name)
            summary = result["summary"]
            note_segments = [entry for entry in summary if str(entry.get("segment_type")) == "tone"]
            rest_segments = [entry for entry in summary if str(entry.get("segment_type")) == "rest"]

            self.assertGreaterEqual(len(note_segments), 4)
            self.assertGreaterEqual(len(rest_segments), 4)
            self.assertTrue(all(entry["voiced_points"] >= 2 for entry in note_segments))
            self.assertTrue(all(entry["semitone_error"] is not None and entry["semitone_error"] < 0.5 for entry in note_segments))
            self.assertTrue(all(entry["voiced_ratio"] <= 0.2 for entry in rest_segments))

    def test_slur_fixture_tracks_continuous_pitch_motion(self) -> None:
        fixture_name = "slur_C4_to_G4_to_E4_144bpm"

        for requested_model in self.module.SUPPORTED_PITCH_MODELS:
            result = self.get_result(requested_model, fixture_name)
            summary = result["summary"]
            slur_segments = [entry for entry in summary if str(entry.get("segment_type")) == "slur"]
            hold_segments = [entry for entry in summary if str(entry.get("segment_type")) == "tone"]

            self.assertGreaterEqual(len(slur_segments), 2)
            self.assertGreaterEqual(len(hold_segments), 3)
            self.assertTrue(all(entry["voiced_points"] >= 6 for entry in slur_segments))
            self.assertTrue(all(entry["mean_semitone_error"] is not None and entry["mean_semitone_error"] < 0.8 for entry in slur_segments))
            self.assertTrue(all(entry["max_semitone_error"] is not None and entry["max_semitone_error"] < 1.6 for entry in slur_segments))
            self.assertTrue(all(entry["semitone_error"] is not None and entry["semitone_error"] < 0.35 for entry in hold_segments))

    def test_harness_generates_markdown_report_for_each_supported_detector(self) -> None:
        for requested_model in self.module.SUPPORTED_PITCH_MODELS:
            report_path = self.report_paths[requested_model]
            self.assertTrue(report_path.exists())

            report_text = report_path.read_text(encoding="utf-8")
            self.assertIn(f"# Pitch Detector Report: {requested_model}", report_text)
            self.assertIn("## Pitch accuracy", report_text)
            self.assertIn("## Pitch detection amplitude sensitivity", report_text)
            self.assertIn("Articulated note mean semitone error", report_text)
            self.assertIn("Slur mean semitone error", report_text)
            self.assertIn(str(ARTIFACT_ROOT), report_text)


if __name__ == "__main__":
    unittest.main()