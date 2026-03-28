import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockCore = {
  isTauri: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  convertFileSrc: ReturnType<typeof vi.fn>;
};

const loadModule = async (options?: {
  core?: MockCore;
  dialogSelection?: string | null;
  dialogError?: Error;
}) => {
  vi.resetModules();
  vi.doUnmock('@tauri-apps/api/core');
  vi.doUnmock('@tauri-apps/plugin-dialog');

  if (options?.core) {
    vi.doMock('@tauri-apps/api/core', () => ({ ...options.core }));
  } else {
    vi.doMock('@tauri-apps/api/core', () => ({
      isTauri: () => false,
      invoke: vi.fn(),
      convertFileSrc: vi.fn(),
    }));
  }

  if (options?.dialogError) {
    vi.doMock('@tauri-apps/plugin-dialog', () => ({
      open: vi.fn().mockRejectedValue(options.dialogError),
    }));
  } else {
    vi.doMock('@tauri-apps/plugin-dialog', () => ({
      open: vi.fn().mockResolvedValue(options?.dialogSelection ?? null),
    }));
  }

  return import('./tauriPreprocess');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.doUnmock('@tauri-apps/api/core');
  vi.doUnmock('@tauri-apps/plugin-dialog');
});

describe('tauriPreprocess desktop boundaries', () => {
  it('falls back to file URLs outside Tauri', async () => {
    const module = await loadModule();

    await expect(module.isDesktopTauri()).resolves.toBe(false);
    await expect(module.convertLocalFileToAssetUrl('C:\\media\\clip.wav')).resolves.toBe('file:///C:/media/clip.wav');
    await expect(module.detectPreprocessBackends()).rejects.toThrow(
      'Desktop preprocessing is only available in the Tauri app.',
    );
  });

  it('uses the native picker only when running in Tauri', async () => {
    const invoke = vi.fn();
    const core: MockCore = {
      isTauri: vi.fn(() => true),
      invoke,
      convertFileSrc: vi.fn((filePath: string) => `asset://${filePath}`),
    };
    const module = await loadModule({ core, dialogSelection: 'C:\\media\\clip.webm' });

    await expect(module.isDesktopTauri()).resolves.toBe(true);
    await expect(module.pickMediaFile()).resolves.toBe('C:\\media\\clip.webm');
    await expect(module.convertLocalFileToAssetUrl('C:\\media\\clip.webm')).resolves.toBe('asset://C:\\media\\clip.webm');
  });

  it('surfaces native dialog failures with a user-facing error', async () => {
    const core: MockCore = {
      isTauri: vi.fn(() => true),
      invoke: vi.fn(),
      convertFileSrc: vi.fn(),
    };
    const module = await loadModule({ core, dialogError: new Error('dialog exploded') });

    await expect(module.pickMediaFile()).rejects.toThrow('dialog exploded');
  });

  it('forwards preprocess and pitch-analysis commands to the Tauri backend with normalized args', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ python: true, demucs: true })
      .mockResolvedValueOnce({ result: 'completed', outputFiles: ['vocals.wav'] })
      .mockResolvedValueOnce({ result: 'completed', pitchPoints: [] });
    const core: MockCore = {
      isTauri: vi.fn(() => true),
      invoke,
      convertFileSrc: vi.fn(),
    };
    const module = await loadModule({ core });

    await expect(module.detectPreprocessBackends()).resolves.toEqual({ python: true, demucs: true });
    await expect(
      module.runPreprocessJob({
        source: 'C:\\media\\clip.webm',
        outputDir: 'C:\\out',
        modelId: 'htdemucs_ft',
      }),
    ).resolves.toEqual({ result: 'completed', outputFiles: ['vocals.wav'] });
    await expect(module.runPitchAnalysisJob({ source: 'C:\\media\\clip.webm' })).resolves.toEqual({
      result: 'completed',
      pitchPoints: [],
    });

    expect(invoke).toHaveBeenNthCalledWith(1, 'detect_preprocess_backends');
    expect(invoke).toHaveBeenNthCalledWith(2, 'run_preprocess_job', {
      source: 'C:\\media\\clip.webm',
      outputDir: 'C:\\out',
      modelId: 'htdemucs_ft',
      modelFile: null,
      dryRun: false,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'run_pitch_analysis', {
      source: 'C:\\media\\clip.webm',
      detectorId: 'librosa-pyin',
    });
  });
});