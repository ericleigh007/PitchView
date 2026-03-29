import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function semitoneError(actualHz, expectedHz) {
  return Math.abs(12 * Math.log2(actualHz / expectedHz));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function pathPointsFromD(pathData) {
  const matches = [...pathData.matchAll(/[ML]([\d.\-]+),([\d.\-]+)/g)];
  return matches.map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
}

function splitEnvelopePoints(points) {
  let splitIndex = points.length;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].x < points[index - 1].x) {
      splitIndex = index;
      break;
    }
  }

  return {
    top: points.slice(0, splitIndex),
    bottom: points.slice(splitIndex)
  };
}

function nearestPoint(points, x) {
  return points.reduce((best, point) => Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best, points[0]);
}

function nearestPitchPointByTime(points, timeSeconds) {
  return points.reduce((best, point) => Math.abs(point.timeSeconds - timeSeconds) < Math.abs(best.timeSeconds - timeSeconds) ? point : best, points[0]);
}

function interpolateRenderedXForTime(points, timeSeconds) {
  if (!points.length) {
    return 0;
  }

  if (timeSeconds <= points[0].timeSeconds) {
    return points[0].cx;
  }

  if (timeSeconds >= points[points.length - 1].timeSeconds) {
    return points[points.length - 1].cx;
  }

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (timeSeconds <= current.timeSeconds) {
      const span = Math.max(current.timeSeconds - previous.timeSeconds, Number.EPSILON);
      const progress = (timeSeconds - previous.timeSeconds) / span;
      return previous.cx + (current.cx - previous.cx) * progress;
    }
  }

  return points[points.length - 1].cx;
}

describe('PitchView calibrated GUI stimulus accuracy', () => {
  it('matches rendered pitch points and envelope heights to the notation-driven stimulus', async function () {
    const configuredMetadataPath = process.env.PITCHVIEW_E2E_STIMULUS_METADATA_PATH;
    const mediaPaths = JSON.parse(process.env.PITCHVIEW_E2E_MEDIA_PATHS || '[]');
    const allowSidecarLookup = process.env.PITCHVIEW_E2E_FIXTURE_KIND === 'stimulus';
    const metadataPath = configuredMetadataPath || (allowSidecarLookup && mediaPaths[0] ? path.format({
      dir: path.dirname(mediaPaths[0]),
      name: path.parse(mediaPaths[0]).name,
      ext: '.json'
    }) : '');
    if (!metadataPath) {
      this.skip();
      return;
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    if (process.env.PITCHVIEW_E2E_FIXTURE_KIND === 'stimulus') {
      const pitchStemSelect = await $('//label[.//span[text()="Pitch stem"]]//select');
      await pitchStemSelect.waitForExist();
      await pitchStemSelect.selectByAttribute('value', 'original');
    }

    const importButton = await $('button=Choose File And Import');
    await importButton.waitForExist();
    await importButton.click();

    const topStatus = await $('.topbar .status-copy');
    await browser.waitUntil(async () => {
      const text = await topStatus.getText();
      return text.includes('Desktop import completed for 1 file(s)')
        || text.includes('Desktop preprocessing completed for 1 file(s)');
    }, {
      timeout: 120000,
      interval: 500,
      timeoutMsg: 'Expected desktop preprocessing completion for calibrated stimulus import.'
    });

    const audio = await $('audio');
    await audio.waitForExist();
    const pitchMarkers = await $$('.pitch-point-marker');
    assert.ok(pitchMarkers.length > 20, 'Expected rendered pitch markers for the calibrated stimulus.');

    const renderedPitchPoints = await browser.execute(() => Array.from(document.querySelectorAll('.pitch-point-marker')).map((element) => ({
      timeSeconds: Number((element).getAttribute('data-time-seconds')),
      frequencyHz: Number((element).getAttribute('data-frequency-hz')),
      cx: Number((element).getAttribute('cx')),
      cy: Number((element).getAttribute('cy'))
    })));

    const playheadAlignment = await browser.execute(() => {
      const pitchPlayhead = document.querySelector('.media-playhead');
      const envelopePlayhead = document.querySelector('.media-envelope-playhead');
      const pitchPointElements = Array.from(document.querySelectorAll('.pitch-point-marker'));

      if (!pitchPlayhead || !envelopePlayhead || !pitchPointElements.length) {
        return null;
      }

      const earliestPitchPoint = pitchPointElements.reduce((best, element) => {
        const timeSeconds = Number(element.getAttribute('data-time-seconds'));
        const bestTimeSeconds = Number(best.getAttribute('data-time-seconds'));
        return timeSeconds < bestTimeSeconds ? element : best;
      });

      const pitchPlayheadRect = pitchPlayhead.getBoundingClientRect();
      const envelopePlayheadRect = envelopePlayhead.getBoundingClientRect();
      const earliestPitchPointRect = earliestPitchPoint.getBoundingClientRect();

      return {
        pitchPlayheadCenterX: pitchPlayheadRect.left + (pitchPlayheadRect.width / 2),
        envelopePlayheadCenterX: envelopePlayheadRect.left + (envelopePlayheadRect.width / 2),
        earliestPitchPointCenterX: earliestPitchPointRect.left + (earliestPitchPointRect.width / 2)
      };
    });

    assert.ok(playheadAlignment, 'Expected the pitch playhead, envelope playhead, and pitch points to be rendered.');
    assert.ok(Math.abs(playheadAlignment.pitchPlayheadCenterX - playheadAlignment.envelopePlayheadCenterX) <= 1.5, 'Expected the pitch playhead and envelope playhead to share the same x position.');
    assert.ok(Math.abs(playheadAlignment.pitchPlayheadCenterX - playheadAlignment.earliestPitchPointCenterX) <= 1.5, 'Expected the playhead to align with the earliest rendered pitch point at time zero.');

    const toneSegments = metadata.segments.filter((segment) => segment.segment_type === 'tone');
    const restSegments = metadata.segments.filter((segment) => segment.segment_type === 'rest');
    const slurSegments = metadata.segments.filter((segment) => segment.segment_type === 'slur');

    for (const segment of toneSegments) {
      const margin = Math.min(0.0125, (segment.end_time_seconds - segment.start_time_seconds) * 0.22);
      const points = renderedPitchPoints.filter((point) => point.timeSeconds >= segment.start_time_seconds + margin && point.timeSeconds <= segment.end_time_seconds - margin);
      assert.ok(points.length >= 4, `Expected GUI pitch points inside ${segment.label}.`);
      const detectedHz = median(points.map((point) => point.frequencyHz));
      assert.ok(semitoneError(detectedHz, segment.frequency_hz) < 0.55, `Expected ${segment.label} to render near the stimulus pitch.`);
    }

    for (const segment of restSegments) {
      const margin = Math.min(0.04, (segment.end_time_seconds - segment.start_time_seconds) * 0.4);
      const points = renderedPitchPoints.filter((point) => point.timeSeconds >= segment.start_time_seconds + margin && point.timeSeconds <= segment.end_time_seconds - margin);
      assert.ok(points.length <= 1, `Expected rest segment ${segment.label} to render with little or no voiced pitch.`);
    }

    for (const segment of slurSegments) {
      const margin = Math.min(0.0125, (segment.end_time_seconds - segment.start_time_seconds) * 0.18);
      const points = renderedPitchPoints.filter((point) => point.timeSeconds >= segment.start_time_seconds + margin && point.timeSeconds <= segment.end_time_seconds - margin);
      assert.ok(points.length >= 6, `Expected GUI pitch points inside slur segment ${segment.label}.`);
      const startLog = Math.log2(segment.start_frequency_hz);
      const endLog = Math.log2(segment.end_frequency_hz);
      const meanError = points.reduce((sum, point) => {
        const progress = (point.timeSeconds - segment.start_time_seconds) / (segment.end_time_seconds - segment.start_time_seconds);
        const expectedHz = 2 ** (startLog + ((endLog - startLog) * progress));
        return sum + semitoneError(point.frequencyHz, expectedHz);
      }, 0) / points.length;
      assert.ok(meanError < 0.9, `Expected slur segment ${segment.label} to follow the stimulus glide.`);
    }

    const envelopePath = await $('.amplitude-strip path');
    await envelopePath.waitForExist();
    const envelopePathData = await envelopePath.getAttribute('d');
    const envelopeViewBox = await (await $('.media-envelope-strip')).getAttribute('viewBox');
    assert.ok(envelopePathData);
    assert.ok(envelopeViewBox);

    const [, , viewBoxWidthText, viewBoxHeightText] = envelopeViewBox.split(' ');
    const viewBoxWidth = Number(viewBoxWidthText);
    const viewBoxHeight = Number(viewBoxHeightText);
    const envelopePoints = splitEnvelopePoints(pathPointsFromD(envelopePathData));
    const envelopeHalfHeight = viewBoxHeight * 0.42;
    const noteHeights = toneSegments.slice(0, 4).map((segment) => {
      const centerTime = (segment.start_time_seconds + segment.end_time_seconds) / 2;
      const pitchPoint = nearestPitchPointByTime(renderedPitchPoints, centerTime);
      const topPoint = nearestPoint(envelopePoints.top, pitchPoint.cx);
      const bottomPoint = nearestPoint(envelopePoints.bottom, pitchPoint.cx);
      const maxXDelta = Math.max(Math.abs(topPoint.x - pitchPoint.cx), Math.abs(bottomPoint.x - pitchPoint.cx));
      assert.ok(maxXDelta <= 1.5, `Expected ${segment.label} pitch points and envelope to share the same x position.`);

      return {
        label: segment.label,
        amplitude: segment.amplitude,
        x: pitchPoint.cx,
        normalizedHeight: (bottomPoint.y - topPoint.y) / (2 * envelopeHalfHeight)
      };
    });

    const restHeights = restSegments.map((segment) => {
      const centerTime = (segment.start_time_seconds + segment.end_time_seconds) / 2;
      const x = interpolateRenderedXForTime(renderedPitchPoints, centerTime);
      const topPoint = nearestPoint(envelopePoints.top, x);
      const bottomPoint = nearestPoint(envelopePoints.bottom, x);
      return (bottomPoint.y - topPoint.y) / (2 * envelopeHalfHeight);
    });

    assert.ok(Math.min(...noteHeights.map((entry) => entry.normalizedHeight)) > Math.max(...restHeights) + 0.08, 'Expected voiced notes to render a taller envelope than rest segments.');
  });
});