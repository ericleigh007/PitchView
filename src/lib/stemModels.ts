export type StemModelProfile = {
  id: string;
  label: string;
  family: string;
  quality: 'fast' | 'balanced' | 'high';
  strengths: string;
  constraints: string;
  output: string;
};

export const stemModelProfiles: StemModelProfile[] = [
  {
    id: 'vocals_mel_band_roformer',
    label: 'Vocals Mel-Band Roformer',
    family: 'Roformer / Audio Separator',
    quality: 'high',
    strengths: 'Strong dedicated vocal extraction with good clarity and reduced accompaniment bleed on dense mixes.',
    constraints: 'Requires the matching checkpoint file and a compatible Audio Separator style backend.',
    output: 'Preferred default for vocal-versus-instrumental preprocessing when this checkpoint is available.',
  },
  {
    id: 'htdemucs_ft',
    label: 'HTDemucs FT',
    family: 'Demucs',
    quality: 'high',
    strengths: 'Strong overall vocal isolation with good musical balance.',
    constraints: 'Heavier runtime and memory footprint than lighter MDX-style models.',
    output: 'Recommended default for full-song vocal plus accompaniment stems.',
  },
  {
    id: 'htdemucs_6s',
    label: 'HTDemucs 6 Stem',
    family: 'Demucs',
    quality: 'high',
    strengths: 'Can separate additional instrument families beyond vocal and accompaniment.',
    constraints: 'Longest processing path of the included options.',
    output: 'Useful when the product later expands beyond simple vocal splitting.',
  },
  {
    id: 'mdx23c',
    label: 'MDX23C',
    family: 'MDX',
    quality: 'balanced',
    strengths: 'Strong vocal separation with a practical quality to speed tradeoff.',
    constraints: 'May leave more accompaniment bleed than HTDemucs on dense mixes.',
    output: 'Good balanced choice for unattended preprocessing jobs.',
  },
  {
    id: 'uvr_mdx_karaoke',
    label: 'UVR MDX Karaoke',
    family: 'UVR / MDX',
    quality: 'balanced',
    strengths: 'Useful when accompaniment-first output is the main target.',
    constraints: 'Less flexible than full multi-stem model families.',
    output: 'Good for original mix plus karaoke-style accompaniment.',
  },
  {
    id: 'spleeter_2stem',
    label: 'Spleeter 2 Stem',
    family: 'Spleeter',
    quality: 'fast',
    strengths: 'Fast turnaround and simple deployment.',
    constraints: 'Lower separation quality on difficult mixes.',
    output: 'Best for quick previews or low-cost preprocessing.',
  },
  {
    id: 'openunmix',
    label: 'Open-Unmix',
    family: 'Open-Unmix',
    quality: 'balanced',
    strengths: 'Stable open model with broad ecosystem familiarity.',
    constraints: 'Usually outperformed by newer Demucs and MDX variants for vocals.',
    output: 'Fallback open model when deployment simplicity matters.',
  },
];

export const defaultStemModelId = stemModelProfiles[0].id;