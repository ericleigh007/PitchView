import { describe, expect, it } from 'vitest';

import { buildAmplitudeWindow } from './amplitudeAnalysis';

describe('buildAmplitudeWindow', () => {
  it('bins amplitude points into the visible time window', () => {
    const buckets = buildAmplitudeWindow(
      [
        { timeSec: 0.1, amplitude: 0.1 },
        { timeSec: 0.2, amplitude: 0.45 },
        { timeSec: 0.52, amplitude: 0.7 },
        { timeSec: 0.81, amplitude: 0.3 },
      ],
      0,
      1,
      5,
    );

    expect(buckets).toEqual([0.1, 0.45, 0.7, 0, 0.3]);
  });

  it('ignores points outside the requested range', () => {
    const buckets = buildAmplitudeWindow(
      [
        { timeSec: 0.05, amplitude: 0.25 },
        { timeSec: 0.35, amplitude: 0.5 },
        { timeSec: 0.55, amplitude: 0.8 },
      ],
      0.3,
      0.6,
      3,
    );

    expect(buckets).toEqual([0.5, 0, 0.8]);
  });
});