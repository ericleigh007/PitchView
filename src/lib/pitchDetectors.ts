export type BrowserPitchDetectorId = 'js-yin';

export type DesktopPitchDetectorId =
  | 'librosa-pyin'
  | 'librosa-pyin-continuous'
  | 'torchcrepe-full'
  | 'torchcrepe-tiny'
  | 'aubio-yinfft';

export type PitchDetectorId = BrowserPitchDetectorId | DesktopPitchDetectorId;

export type PitchDetectorRuntime = 'browser' | 'desktop';

export type PitchDetectorDefinition = {
  id: PitchDetectorId;
  label: string;
  runtime: PitchDetectorRuntime;
  notes?: string;
};

export type PitchAnalysisStrategy = {
  primaryBrowserDetectorId: BrowserPitchDetectorId;
  desktopFallbackDetectorId: DesktopPitchDetectorId;
  liveInputDetectorId: DesktopPitchDetectorId;
};

export const PITCH_DETECTORS: Record<PitchDetectorId, PitchDetectorDefinition> = {
  'js-yin': {
    id: 'js-yin',
    label: 'JS YIN',
    runtime: 'browser',
    notes: 'Current best overall contour/render path in the app.',
  },
  'librosa-pyin': {
    id: 'librosa-pyin',
    label: 'librosa pYIN',
    runtime: 'desktop',
    notes: 'Best current desktop fallback for offline file analysis quality.',
  },
  'librosa-pyin-continuous': {
    id: 'librosa-pyin-continuous',
    label: 'librosa pYIN continuous',
    runtime: 'desktop',
  },
  'torchcrepe-full': {
    id: 'torchcrepe-full',
    label: 'torchcrepe full',
    runtime: 'desktop',
    notes: 'Higher-cost neural backend kept for future low-latency/live work.',
  },
  'torchcrepe-tiny': {
    id: 'torchcrepe-tiny',
    label: 'torchcrepe tiny',
    runtime: 'desktop',
    notes: 'Likely best starting point for live pitch tracking experiments.',
  },
  'aubio-yinfft': {
    id: 'aubio-yinfft',
    label: 'aubio yinfft',
    runtime: 'desktop',
  },
};

export const DEFAULT_PITCH_ANALYSIS_STRATEGY: PitchAnalysisStrategy = {
  primaryBrowserDetectorId: 'js-yin',
  desktopFallbackDetectorId: 'librosa-pyin',
  liveInputDetectorId: 'torchcrepe-tiny',
};

export const isDesktopPitchDetectorId = (detectorId: PitchDetectorId): detectorId is DesktopPitchDetectorId => {
  return PITCH_DETECTORS[detectorId].runtime === 'desktop';
};
