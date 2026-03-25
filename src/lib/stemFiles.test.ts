import { describe, expect, it } from 'vitest';

import { classifyGeneratedStemFile } from './stemFiles';

describe('classifyGeneratedStemFile', () => {
  it('prefers explicit other-stem markers over model-name vocals text', () => {
    expect(
      classifyGeneratedStemFile(
        'sample/out/imported/song_(other)_vocals_mel_band_roformer.wav',
      ),
    ).toEqual({ id: 'other', label: 'Other stem' });
  });

  it('detects vocals outputs from explicit vocals markers', () => {
    expect(
      classifyGeneratedStemFile(
        'sample/out/imported/song_(vocals)_vocals_mel_band_roformer.wav',
      ),
    ).toEqual({ id: 'vocals', label: 'Separated vocals' });
  });

  it('returns null for unrelated files', () => {
    expect(classifyGeneratedStemFile('sample/out/imported/song_preview_mix.wav')).toBeNull();
  });
});