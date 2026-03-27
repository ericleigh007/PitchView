import { describe, expect, it } from 'vitest';

import { smoothPitchTrack } from './pitchTrackSmoothing';
import type { PitchPoint } from './types';

const point = (timeSec: number, midi: number | null, confidence = 0.8): PitchPoint => ({
  timeSec,
  midi,
  confidence,
});

describe('smoothPitchTrack', () => {
  it('suppresses short octave bursts in the raw detector output', () => {
    const smoothed = smoothPitchTrack([
      point(0, 58.0, 0.8),
      point(0.006, 58.1, 0.8),
      point(0.012, 70.1, 0.9),
      point(0.018, 70.0, 0.9),
      point(0.024, 58.2, 0.8),
      point(0.03, 58.1, 0.8),
    ]);

    expect(smoothed[2]?.midi).toBeCloseTo(58.15, 1);
    expect(smoothed[3]?.midi).toBeCloseTo(58.15, 1);
  });

  it('fills short null-only gaps between nearby notes', () => {
    const smoothed = smoothPitchTrack([
      point(0, 63.1, 0.4),
      point(0.012, 63.0, 0.4),
      point(0.024, null, 0),
      point(0.036, null, 0),
      point(0.048, null, 0),
      point(0.06, 60.2, 0.4),
      point(0.072, 60.0, 0.4),
    ]);

    expect(smoothed[2]?.midi).not.toBeNull();
    expect(smoothed[3]?.midi).not.toBeNull();
    expect(smoothed[4]?.midi).not.toBeNull();
    expect(smoothed[3]?.midi).toBeCloseTo(61.6, 1);
  });

  it('does not fill longer unvoiced gaps', () => {
    const smoothed = smoothPitchTrack([
      point(0, 63.1, 0.4),
      point(0.012, 63.0, 0.4),
      point(0.024, null, 0),
      point(0.06, null, 0),
      point(0.096, null, 0),
      point(0.132, 60.2, 0.4),
    ]);

    expect(smoothed[2]?.midi).toBeNull();
    expect(smoothed[3]?.midi).toBeNull();
    expect(smoothed[4]?.midi).toBeNull();
  });

  it('promotes a brief weak voiced dip so the graph stays continuous', () => {
    const smoothed = smoothPitchTrack([
      point(0, 63.1, 0.42),
      point(0.012, 63.0, 0.42),
      point(0.024, 62.95, 0.06),
      point(0.036, 63.05, 0.41),
      point(0.048, 63.0, 0.43),
    ]);

    expect(smoothed[2]?.midi).toBeCloseTo(62.95, 2);
    expect(smoothed[2]?.confidence).toBeGreaterThanOrEqual(0.18);
  });
});