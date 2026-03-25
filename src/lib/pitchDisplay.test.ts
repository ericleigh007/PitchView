import { describe, expect, it } from 'vitest';

import { buildPitchSegments } from './pitchDisplay';
import type { PitchPoint } from './types';

const point = (timeSec: number, midi: number | null, confidence = 0.8): PitchPoint => ({
  timeSec,
  midi,
  confidence,
});

describe('buildPitchSegments', () => {
  it('bridges tiny null gaps between otherwise continuous notes', () => {
    const segments = buildPitchSegments(
      [point(0, 60), point(0.012, 60.2), point(0.024, null, 0), point(0.036, 60.3), point(0.048, 60.5)],
      0,
      1,
      48,
      72,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(4);
  });

  it('keeps abrupt note changes connected when there is no silence gap', () => {
    const segments = buildPitchSegments(
      [point(0, 52), point(0.012, 52.1), point(0.024, 69), point(0.036, 69.2)],
      0,
      1,
      48,
      80,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].map((entry) => Math.round(entry.midi))).toEqual([52, 52, 69, 69]);
  });

  it('breaks segments when the detector reports an actual missing region', () => {
    const segments = buildPitchSegments(
      [point(0, 52), point(0.012, 52.1), point(0.024, null, 0), point(0.096, 69), point(0.108, 69.2)],
      0,
      1,
      48,
      80,
      0.14,
    );

    expect(segments).toHaveLength(2);
    expect(segments[0].map((entry) => Math.round(entry.midi))).toEqual([52, 52]);
    expect(segments[1].map((entry) => Math.round(entry.midi))).toEqual([69, 69]);
  });

  it('suppresses isolated one-frame spikes between stable neighbors', () => {
    const segments = buildPitchSegments(
      [point(0, 60), point(0.012, 60.1), point(0.024, 67), point(0.036, 60.2), point(0.048, 60.3)],
      0,
      1,
      48,
      80,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0][2].midi).toBeCloseTo(60.15, 1);
  });
});