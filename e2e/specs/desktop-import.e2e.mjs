import assert from 'node:assert/strict';

const IMPORT_COMPLETION_TIMEOUT_MS = process.env.PITCHVIEW_E2E_MEDIA_PATHS ? 420000 : 120000;

describe('PitchView desktop import flow', () => {
  it('imports media, renders contours before playback, reuses cache, and generates stems', async function () {
    this.timeout(720000);

    if (process.env.PITCHVIEW_E2E_FIXTURE_KIND === 'stimulus') {
      return;
    }

    const bypassCacheToggle = await $('[aria-label="Bypass preprocessing cache"]');
    await bypassCacheToggle.waitForExist();

    const importButton = await $('button=Choose File And Import');
    await importButton.waitForExist();
    await importButton.click();

    const topStatus = await $('.topbar .status-copy');
    await browser.waitUntil(async () => {
      const text = await topStatus.getText();
      return text.includes('Desktop import completed for 1 file(s)');
    }, {
      timeout: IMPORT_COMPLETION_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: 'Expected desktop import completion status after first import.'
    });

    const video = await $('video');
    const audio = await $('audio');
    await video.waitForExist();
    await audio.waitForExist();
    assert.match(await video.getAttribute('src'), /display\.mp4$/i);
    assert.match(await audio.getAttribute('src'), /playback\.wav$/i);

    const pitchPath = await $('.pitch-overlay path');
    const amplitudePath = await $('.amplitude-strip path');
    await pitchPath.waitForExist();
    await amplitudePath.waitForExist();
    assert.ok((await pitchPath.getAttribute('d'))?.length);
    assert.ok((await amplitudePath.getAttribute('d'))?.length);

    const seekSlider = await $('[aria-label="Seek Player 1"]');
    await seekSlider.waitForExist();
    assert.equal(await seekSlider.getValue(), '0');

    const playerProgressShell = await seekSlider.parentElement();
    const timelineTicks = await playerProgressShell.$$('.player-timeline-tick');
    assert.equal(timelineTicks.length, 5);

    const playButton = await $('[aria-label="Play"]');
    await playButton.click();

    await browser.waitUntil(async () => {
      const currentTime = await browser.execute(() => {
        const audio = document.querySelector('audio');
        return audio instanceof HTMLMediaElement ? audio.currentTime : 0;
      });
      return Number(currentTime) > 0.5;
    }, {
      timeout: 15000,
      interval: 250,
      timeoutMsg: 'Expected media playback time to advance after clicking Play.'
    });

    await browser.waitUntil(async () => Number(await seekSlider.getValue()) > 0.25, {
      timeout: 15000,
      interval: 250,
      timeoutMsg: 'Expected seek slider value to advance after clicking Play.'
    });

    await importButton.click();

    await browser.waitUntil(async () => {
      const text = await topStatus.getText();
      return text.includes('Running desktop import preprocessing');
    }, {
      timeout: 10000,
      interval: 100,
      timeoutMsg: 'Expected preprocessing status to reset when starting the second import.'
    });

    const progressBar = await $('.preprocess-progress-track');
    await progressBar.waitForExist();
    assert.notEqual(await progressBar.getAttribute('aria-valuenow'), '100');

    await browser.waitUntil(async () => {
      const text = await topStatus.getText();
      return text.includes('1/1 import(s) reused cached preprocessing.');
    }, {
      timeout: 120000,
      interval: 500,
      timeoutMsg: 'Expected cache reuse status after second import.'
    });

    const stemsButton = await $('[aria-label="Generate stems for Player 1"]');
    await stemsButton.click();

    await browser.waitUntil(async () => {
      const text = await topStatus.getText();
      return text.includes('Generated stem mappings for Player 1.');
    }, {
      timeout: 180000,
      interval: 500,
      timeoutMsg: 'Expected stem generation completion status.'
    });

    const menuButton = await $('[aria-label="Open menu for Player 1"]');
    await menuButton.click();

    const sourceSelect = await $('//label[.//span[normalize-space()="Source"]]//select');
    await sourceSelect.waitForExist();
    const sourceOptions = await sourceSelect.$$('option');
    const labels = [];
    for (const option of sourceOptions) {
      labels.push(await option.getText());
    }
    assert.ok(labels.includes('Vocals stem'));
    assert.ok(labels.includes('Other stem'));
  });
});
