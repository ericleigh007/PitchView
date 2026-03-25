import type { StemModelProfile } from './stemModels';

export type PreprocessBackend = 'demucs' | 'audio_separator' | 'spleeter' | 'openunmix';

export type PreprocessPlan = {
  backend: PreprocessBackend;
  installHint: string;
  expectedOutputs: string[];
  commandPreview: string;
};

const backendByModelId: Record<string, PreprocessBackend> = {
  vocals_mel_band_roformer: 'audio_separator',
  htdemucs_ft: 'demucs',
  htdemucs_6s: 'demucs',
  mdx23c: 'audio_separator',
  uvr_mdx_karaoke: 'audio_separator',
  spleeter_2stem: 'spleeter',
  openunmix: 'openunmix',
};

export function buildPreprocessPlan(model: StemModelProfile): PreprocessPlan {
  const backend = backendByModelId[model.id];

  switch (backend) {
    case 'demucs':
      return {
        backend,
        installHint: 'pip install demucs',
        expectedOutputs: model.id === 'htdemucs_6s' ? ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] : ['vocals', 'no_vocals'],
        commandPreview: `python -m demucs.separate -n ${model.id} --two-stems vocals -o <output-dir> <source>`,
      };
    case 'audio_separator':
      return {
        backend,
        installHint: 'pip install audio-separator[gpu] or audio-separator',
        expectedOutputs:
          model.id === 'vocals_mel_band_roformer'
            ? ['vocals', 'other']
            : ['vocals', model.id === 'uvr_mdx_karaoke' ? 'karaoke' : 'instrumental'],
        commandPreview:
          model.id === 'vocals_mel_band_roformer'
            ? 'python tools/preprocess_media.py run --source <source> --output-dir <output-dir> --model-id vocals_mel_band_roformer --model-file <checkpoint-path>'
            : `python -m audio_separator <source> --model_filename <model> --output_dir <output-dir>`,
      };
    case 'spleeter':
      return {
        backend,
        installHint: 'pip install spleeter',
        expectedOutputs: ['vocals', 'accompaniment'],
        commandPreview: 'python -m spleeter separate -p spleeter:2stems -o <output-dir> <source>',
      };
    case 'openunmix':
      return {
        backend,
        installHint: 'pip install openunmix',
        expectedOutputs: ['vocals', 'instrumental'],
        commandPreview: 'python -m openunmix <source> <output-dir>',
      };
  }
}