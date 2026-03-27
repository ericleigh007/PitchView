import { describe, expect, it } from 'vitest';

import { evaluatePitchTrackQuality } from './pitchAnalysis';
import type { PitchPoint } from './types';

const point = (timeSec: number, midi: number | null, confidence = 0.8): PitchPoint => ({
  timeSec,
  midi,
  confidence,
});

describe('evaluatePitchTrackQuality', () => {
  it('scores a continuous voiced contour above a sparse broken contour', () => {
    const continuousTrack = [
      point(0.0, 60.1, 0.88),
      point(0.012, 60.0, 0.9),
      point(0.024, 60.2, 0.86),
      point(0.036, 60.15, 0.89),
      point(0.048, 60.05, 0.85),
      point(0.06, 60.1, 0.84),
    ];
    const sparseTrack = [
      point(0.0, 60.1, 0.35),
      point(0.012, null, 0),
      point(0.024, null, 0),
      point(0.036, 71.8, 0.3),
      point(0.048, null, 0),
      point(0.06, 60.0, 0.28),
    ];

    const continuousQuality = evaluatePitchTrackQuality(continuousTrack);
    const sparseQuality = evaluatePitchTrackQuality(sparseTrack);

    expect(continuousQuality.voicedRatio).toBeGreaterThan(sparseQuality.voicedRatio);
    expect(continuousQuality.continuityRatio).toBeGreaterThan(sparseQuality.continuityRatio);
    expect(continuousQuality.score).toBeGreaterThan(sparseQuality.score);
  });

  it('penalizes transient-heavy octave-glitch tracks', () => {
    const stableTrack = [
      point(0.0, 58.4, 0.86),
      point(0.012, 58.45, 0.88),
      point(0.024, 58.5, 0.84),
      point(0.036, 58.46, 0.85),
      point(0.048, 58.42, 0.86),
      point(0.06, 58.44, 0.87),
    ];
    const glitchyTrack = [
      point(0.0, 58.4, 0.7),
      point(0.012, 70.4, 0.92),
      point(0.024, 58.45, 0.7),
      point(0.036, null, 0),
      point(0.048, 70.3, 0.9),
      point(0.06, 58.42, 0.71),
    ];

    const stableQuality = evaluatePitchTrackQuality(stableTrack);
    const glitchyQuality = evaluatePitchTrackQuality(glitchyTrack);

    expect(glitchyQuality.octaveIslandCount).toBeGreaterThanOrEqual(1);
    expect(stableQuality.score).toBeGreaterThan(glitchyQuality.score);
  });
});