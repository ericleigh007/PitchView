export type WorkerResult = {
  result?: string;
  outputFiles?: string[];
  stderr?: string;
  stdout?: string;
  resolvedModelFile?: string | null;
  modelDownloadRequired?: boolean;
  [key: string]: unknown;
};

export type DialogSelection = string | null;

export type BackendDetectionResult = {
  python: boolean;
  demucs: boolean;
  audio_separator: boolean;
  librosa: boolean;
  aubio: boolean;
  onnxruntime: boolean;
  spleeter: boolean;
  openunmix: boolean;
  imageio_ffmpeg: boolean;
  ffmpeg: boolean;
  ffmpegSource?: string | null;
  ffprobe: boolean;
  ffprobeSource?: string | null;
};

type TauriCore = {
  isTauri: () => boolean;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  convertFileSrc: (filePath: string, protocol?: string) => string;
};

const getTauriCore = async (): Promise<TauriCore | null> => {
  try {
    const core = await import('@tauri-apps/api/core');
    return core.isTauri() ? core : null;
  } catch {
    return null;
  }
};

export const isDesktopTauri = async () => (await getTauriCore()) !== null;

export const pickMediaFile = async (): Promise<DialogSelection> => {
  const core = await getTauriCore();
  if (!core) {
    throw new Error('Browse Native is only available in the Tauri desktop app. Launch PitchView with launch-tauri.bat.');
  }

  try {
    const dialog = await import('@tauri-apps/plugin-dialog');
    const selection = await dialog.open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: 'Media',
          extensions: ['wav', 'mp3', 'flac', 'm4a', 'aiff', 'aif', 'ogg', 'opus', 'mp4', 'mov', 'mkv', 'webm'],
        },
      ],
    });

    return typeof selection === 'string' ? selection : null;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'The native file picker failed to open.');
  }
};

export const convertLocalFileToAssetUrl = async (filePath: string) => {
  const core = await getTauriCore();
  if (!core) {
    return `file:///${filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:')}`;
  }

  return core.convertFileSrc(filePath);
};

export const detectPreprocessBackends = async () => {
  const core = await getTauriCore();
  if (!core) {
    throw new Error('Desktop preprocessing is only available in the Tauri app.');
  }

  return core.invoke<BackendDetectionResult>('detect_preprocess_backends');
};

export const runPreprocessJob = async (args: {
  source: string;
  outputDir: string;
  modelId: string;
  modelFile?: string | null;
  dryRun?: boolean;
}) => {
  const core = await getTauriCore();
  if (!core) {
    throw new Error('Desktop preprocessing is only available in the Tauri app.');
  }

  return core.invoke<WorkerResult>('run_preprocess_job', {
    source: args.source,
    outputDir: args.outputDir,
    modelId: args.modelId,
    modelFile: args.modelFile ?? null,
    dryRun: args.dryRun ?? false,
  });
};

export const runPitchAnalysisJob = async (args: {
  source: string;
  detectorId?: string;
}) => {
  const core = await getTauriCore();
  if (!core) {
    throw new Error('Desktop pitch analysis is only available in the Tauri app.');
  }

  return core.invoke<WorkerResult>('run_pitch_analysis', {
    source: args.source,
    detectorId: args.detectorId ?? 'librosa-pyin',
  });
};
