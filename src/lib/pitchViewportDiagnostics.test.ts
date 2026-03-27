import { describe, expect, it } from 'vitest';

import { scanRenderedOctaveGlitches } from './pitchViewportDiagnostics';
import type { PitchPoint } from './types';

const point = (timeSec: number, midi: number | null, confidence = 0.9): PitchPoint => ({
  timeSec,
  midi,
  confidence,
});

describe('scanRenderedOctaveGlitches', () => {
  it('reports no surviving rendered windows for a suppressed short octave island', () => {
    const pitchPoints = [
      point(0.0, 58.56),
      point(0.006, 58.45),
      point(0.012, 70.35),
      point(0.018, 70.2),
      point(0.024, 58.5),
      point(0.03, 58.48),
    ];

    const result = scanRenderedOctaveGlitches(pitchPoints, {
      timeScaleSec: 0.1,
      pitchRangeSemitones: 18,
      durationSec: 0.03,
      pitchCenterMode: 'fixed',
      fixedMidiCenter: 55,
    });

    expect(result.rawOctaveIslands).toHaveLength(1);
    expect(result.survivingRenderedWindows).toHaveLength(0);
  });

    it('detects raw octave islands in longer octave-shift runs', () => {
    const pitchPoints = [
      point(0.0, 49.02),
      point(0.006, 49.05),
      point(0.012, 61.42),
      point(0.018, 61.31),
      point(0.024, 61.26),
      point(0.03, 61.22),
      point(0.036, 49.08),
      point(0.042, 49.04),
    ];

    const result = scanRenderedOctaveGlitches(pitchPoints, {
      timeScaleSec: 0.1,
      pitchRangeSemitones: 18,
      durationSec: 0.042,
    });

      expect(result.rawOctaveIslands.length).toBeGreaterThan(0);
  });
});