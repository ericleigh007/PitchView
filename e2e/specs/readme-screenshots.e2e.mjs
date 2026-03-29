import fs from 'node:fs';
import path from 'node:path';

const screenshotRoot = path.resolve(process.cwd(), 'docs', 'screenshots');

async function waitForStatusText(expectedText) {
  const status = await $('.topbar .status-copy');
  await status.waitForExist();
  await browser.waitUntil(async () => (await status.getText()).includes(expectedText), {
    timeout: 15000,
    interval: 250,
    timeoutMsg: `Expected status to include: ${expectedText}`
  });
}

describe('PitchView README screenshots', () => {
  before(function () {
    if (process.env.PITCHVIEW_CAPTURE_README_SCREENSHOTS !== '1') {
      this.skip();
    }
  });

  it('captures desktop screenshots from the scripted demo workspace', async () => {
    fs.mkdirSync(screenshotRoot, { recursive: true });

    await browser.setWindowSize(1600, 1200);

    const topbar = await $('.topbar');
    await topbar.waitForExist();
    await browser.pause(500);

    const demoButton = await $('button[aria-label="Load demo"]');
    await demoButton.waitForClickable();
    await demoButton.click();

    await waitForStatusText('Loaded scripted demo workspace');
    await browser.pause(500);
    await browser.saveScreenshot(path.join(screenshotRoot, 'pitchview-demo-workspace.png'));

    const layerMenuButton = await $('button[aria-label="Open menu for Player 1"]');
    await layerMenuButton.waitForClickable();
    await layerMenuButton.click();

    const layerMenu = await $('.layer-menu');
    await layerMenu.waitForDisplayed();
    await browser.pause(250);
    await browser.saveScreenshot(path.join(screenshotRoot, 'pitchview-layer-settings.png'));
  });
});