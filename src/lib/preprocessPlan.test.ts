import { describe, expect, it } from 'vitest';

import { buildPreprocessPlan } from './preprocessPlan';
import { stemModelProfiles } from './stemModels';

const getModel = (modelId: string) => {
  const model = stemModelProfiles.find((entry) => entry.id === modelId);
  if (!model) {
    throw new Error(`Missing test model: ${modelId}`);
  }
  return model;
};

describe('buildPreprocessPlan', () => {
  it('maps the Roformer vocal model to the audio_separator backend', () => {
    expect(buildPreprocessPlan(getModel('vocals_mel_band_roformer'))).toEqual({
      backend: 'audio_separator',
      installHint: 'pip install audio-separator[gpu] or audio-separator',
      expectedOutputs: ['vocals', 'other'],
      commandPreview:
        'python tools/preprocess_media.py run --source <source> --output-dir <output-dir> --model-id vocals_mel_band_roformer --model-file <checkpoint-path>',
    });
  });

  it('maps Demucs models to the demucs backend with the right output shape', () => {
    expect(buildPreprocessPlan(getModel('htdemucs_ft'))).toEqual({
      backend: 'demucs',
      installHint: 'pip install demucs',
      expectedOutputs: ['vocals', 'no_vocals'],
      commandPreview: 'python -m demucs.separate -n htdemucs_ft --two-stems vocals -o <output-dir> <source>',
    });

    expect(buildPreprocessPlan(getModel('htdemucs_6s')).expectedOutputs).toEqual([
      'vocals',
      'drums',
      'bass',
      'other',
      'guitar',
      'piano',
    ]);
  });

  it('maps Spleeter and Open-Unmix to their own backend modes', () => {
    expect(buildPreprocessPlan(getModel('spleeter_2stem'))).toEqual({
      backend: 'spleeter',
      installHint: 'pip install spleeter',
      expectedOutputs: ['vocals', 'accompaniment'],
      commandPreview: 'python -m spleeter separate -p spleeter:2stems -o <output-dir> <source>',
    });

    expect(buildPreprocessPlan(getModel('openunmix'))).toEqual({
      backend: 'openunmix',
      installHint: 'pip install openunmix',
      expectedOutputs: ['vocals', 'instrumental'],
      commandPreview: 'python -m openunmix <source> <output-dir>',
    });
  });
});