import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appDataDir, createFixtureMedia, ensureDesktopBinary, repoRoot, resetDesktopState } from './helpers.mjs';

const EXTERNAL_MEDIA_TIMEOUT_MS = process.env.PITCHVIEW_E2E_MEDIA_PATHS ? 720000 : 180000;

let tauriDriver;
let isDriverShutdownExpected = false;

function closeTauriDriver() {
  isDriverShutdownExpected = true;
  tauriDriver?.kill();
}

function registerShutdown(handler) {
  const cleanup = () => {
    handler();
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('SIGHUP', cleanup);
  process.once('SIGBREAK', cleanup);
}

registerShutdown(() => {
  closeTauriDriver();
});

export const config = {
  runner: 'local',
  hostname: '127.0.0.1',
  port: 4444,
  specs: [path.join(repoRoot, 'e2e', 'specs', '**', '*.e2e.mjs')],
  maxInstances: 1,
  logLevel: 'info',
  waitforTimeout: 120000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,
  services: [],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: EXTERNAL_MEDIA_TIMEOUT_MS
  },
  capabilities: [{
    maxInstances: 1,
    'tauri:options': {
      application: ensureDesktopBinary()
    }
  }],
  onPrepare() {
    const fixture = createFixtureMedia();
    resetDesktopState();
    process.env.PITCHVIEW_E2E_MEDIA_PATHS = JSON.stringify([fixture.mediaPath]);
    process.env.PITCHVIEW_E2E_STIMULUS_METADATA_PATH = fixture.metadataPath || '';
    process.env.PITCHVIEW_E2E_APPDATA_DIR = appDataDir;
  },
  beforeSession() {
    const driverName = process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver';
    const driverPath = path.resolve(os.homedir(), '.cargo', 'bin', driverName);
    const tauriDriverArgs = [];

    if (process.env.PITCHVIEW_E2E_NATIVE_DRIVER) {
      tauriDriverArgs.push('--native-driver', process.env.PITCHVIEW_E2E_NATIVE_DRIVER);
    }

    tauriDriver = spawn(driverPath, tauriDriverArgs, {
      stdio: [null, process.stdout, process.stderr],
      env: process.env
    });

    tauriDriver.on('error', (error) => {
      console.error('tauri-driver error:', error);
      process.exit(1);
    });

    tauriDriver.on('exit', (code) => {
      if (!isDriverShutdownExpected) {
        console.error('tauri-driver exited unexpectedly with code:', code);
        process.exit(1);
      }
    });
  },
  afterSession() {
    closeTauriDriver();
  }
};
