import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, '..');
export const fixtureDir = path.join(repoRoot, '.tmp', 'gui-e2e');
export const fixtureMediaPath = path.join(fixtureDir, 'clip.mp4');
export const stimulusFixturePath = path.join(fixtureDir, 'stimulus_accuracy.wav');
export const stimulusMetadataPath = path.join(fixtureDir, 'stimulus_accuracy.json');
export const externalClipPath = path.join(fixtureDir, 'external_clip.mp4');
export const desktopBinaryPath = path.join(repoRoot, 'app', 'desktop', 'src-tauri', 'target', 'debug', 'pitchview-desktop.exe');
export const appDataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'com.pitchview.app');
export const stimulusNotationPath = path.join(repoRoot, 'e2e', 'fixtures', 'stimulus-accuracy.pvabc');
const defaultExternalClipSeconds = 10;

function resolvePythonCommand() {
  const localVenvPython = path.join(repoRoot, '.venv', 'Scripts', 'python.exe');

  if (fs.existsSync(localVenvPython)) {
    return localVenvPython;
  }

  throw new Error('PitchView E2E requires the repository Python environment at .venv/Scripts/python.exe.');
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: false,
    ...options
  });

  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
      result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : ''
    ].filter(Boolean).join('\n\n'));
  }

  return result;
}

export function detectBackend() {
  const python = resolvePythonCommand();
  const result = runCommand(python, ['tools/preprocess_media.py', 'check-backend']);
  return JSON.parse(result.stdout);
}

function resolveExternalClipSeconds() {
  const configuredSeconds = Number(process.env.PITCHVIEW_E2E_EXTERNAL_CLIP_SECONDS || defaultExternalClipSeconds);

  if (!Number.isFinite(configuredSeconds) || configuredSeconds <= 0) {
    return defaultExternalClipSeconds;
  }

  return configuredSeconds;
}

function createExternalMediaClip(inputPath) {
  const backend = detectBackend();
  const clipSeconds = resolveExternalClipSeconds();

  fs.mkdirSync(fixtureDir, { recursive: true });

  runCommand(backend.ffmpeg_path || 'ffmpeg', [
    '-y',
    '-ss', '0',
    '-t', String(clipSeconds),
    '-i', inputPath,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    externalClipPath
  ]);

  return externalClipPath;
}

export function resetDesktopState() {
  fs.rmSync(appDataDir, { recursive: true, force: true });
  fs.mkdirSync(appDataDir, { recursive: true });
}

export function createFixtureMedia() {
  if (process.env.PITCHVIEW_E2E_MEDIA_PATHS?.trim()) {
    const configuredPaths = JSON.parse(process.env.PITCHVIEW_E2E_MEDIA_PATHS);
    const mediaPath = Array.isArray(configuredPaths) ? configuredPaths[0] : null;
    if (!mediaPath) {
      throw new Error('PITCHVIEW_E2E_MEDIA_PATHS must be a JSON array with at least one media path.');
    }

    const clippedMediaPath = createExternalMediaClip(mediaPath);

    return {
      mediaPath: clippedMediaPath,
      metadataPath: process.env.PITCHVIEW_E2E_STIMULUS_METADATA_PATH || null
    };
  }

  const fixtureKind = process.env.PITCHVIEW_E2E_FIXTURE_KIND || 'video';
  const backend = detectBackend();
  fs.mkdirSync(fixtureDir, { recursive: true });

  if (fixtureKind === 'stimulus') {
    const python = resolvePythonCommand();
    runCommand(python, [
      'tools/generate_stimulus_fixture.py',
      fixtureDir,
      'stimulus_accuracy',
      '--notation-file',
      stimulusNotationPath
    ]);

    return {
      mediaPath: stimulusFixturePath,
      metadataPath: stimulusMetadataPath
    };
  }

  runCommand(backend.ffmpeg_path || 'ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=320x240:d=1.5',
    '-f', 'lavfi',
    '-i', 'sine=frequency=220:sample_rate=44100:duration=1.5',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    fixtureMediaPath
  ]);

  return {
    mediaPath: fixtureMediaPath,
    metadataPath: null
  };
}

export function ensureDesktopBinary() {
  if (!fs.existsSync(desktopBinaryPath)) {
    throw new Error(`Desktop binary not found at ${desktopBinaryPath}. Run ./scripts/build.ps1 -BuildDesktopBinary, ./scripts/gui-test.ps1, or ./scripts/capture-readme-screenshots.ps1 first.`);
  }

  return desktopBinaryPath;
}
