import { useState } from 'react';
import { buildPitchSegments, buildVisiblePitchPoints } from '../lib/pitchDisplay';
import { midiToNoteLabel } from '../lib/sync';
import type { PlayerState } from '../lib/types';

type PitchGraphProps = {
  player: PlayerState;
  focusTimeSec: number;
  timeScaleSec: number;
  pitchRangeSemitones: number;
  midiCenter: number;
  emphasis?: number;
  lineOpacity?: number;
};

const WIDTH = 820;
const HEIGHT = 430;
const LEFT_GUTTER = 58;
const TOP_GUTTER = 16;
const RIGHT_GUTTER = 16;
const BOTTOM_GUTTER = 44;
const MIN_GRAPH_CONFIDENCE = 0.1;
const HOVER_SNAP_DISTANCE_PX = 22;

type HoverProbe = {
  cursorX: number;
  cursorY: number;
  pointX: number;
  pointY: number;
  timeSec: number;
  midi: number;
};

export function PitchGraph({
  player,
  focusTimeSec,
  timeScaleSec,
  pitchRangeSemitones,
  midiCenter,
  emphasis = 1,
  lineOpacity = 1,
}: PitchGraphProps) {
  const [hoverProbe, setHoverProbe] = useState<HoverProbe | null>(null);
  const halfRange = timeScaleSec / 2;
  const rangeStart = Math.max(0, focusTimeSec - halfRange);
  const rangeEnd = rangeStart + timeScaleSec;
  const midiMax = midiCenter + pitchRangeSemitones / 2;
  const midiMin = midiCenter - pitchRangeSemitones / 2;
  const plotWidth = WIDTH - LEFT_GUTTER - RIGHT_GUTTER;
  const plotHeight = HEIGHT - TOP_GUTTER - BOTTOM_GUTTER;

  const timeTicks = Array.from({ length: 5 }, (_, index) => rangeStart + (timeScaleSec / 4) * index);
  const noteTicks = Array.from({ length: pitchRangeSemitones + 1 }, (_, index) => midiMin + index).reverse();

  const toX = (timeSec: number) => LEFT_GUTTER + ((timeSec - rangeStart) / timeScaleSec) * plotWidth;
  const toY = (midi: number) => TOP_GUTTER + ((midiMax - midi) / pitchRangeSemitones) * plotHeight;

  const segments = buildPitchSegments(player.pitchPoints, rangeStart, rangeEnd, midiMin, midiMax, MIN_GRAPH_CONFIDENCE).map((segment) =>
    segment
      .map((entry, index) => `${index === 0 ? 'M' : 'L'}${toX(entry.timeSec).toFixed(2)} ${toY(entry.midi).toFixed(2)}`)
      .join(' '),
  );
  const visiblePoints = buildVisiblePitchPoints(
    player.pitchPoints,
    rangeStart,
    rangeEnd,
    midiMin,
    midiMax,
    MIN_GRAPH_CONFIDENCE,
  );
  const effectiveLineOpacity = Math.min(1, Math.max(0.3, emphasis * lineOpacity));
  const effectiveGlowOpacity = Math.min(0.1, effectiveLineOpacity * 0.08);
  const tooltipWidth = 130;
  const tooltipHeight = 44;

  const handlePointerLeave = () => {
    setHoverProbe(null);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (visiblePoints.length === 0) {
      setHoverProbe(null);
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const scaleX = WIDTH / bounds.width;
    const scaleY = HEIGHT / bounds.height;
    const cursorX = (event.clientX - bounds.left) * scaleX;
    const cursorY = (event.clientY - bounds.top) * scaleY;

    let nearestPoint: HoverProbe | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const point of visiblePoints) {
      const pointX = toX(point.timeSec);
      const pointY = toY(point.midi);
      const deltaX = pointX - cursorX;
      const deltaY = pointY - cursorY;
      const distance = Math.hypot(deltaX, deltaY);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPoint = {
          cursorX,
          cursorY,
          pointX,
          pointY,
          timeSec: point.timeSec,
          midi: point.midi,
        };
      }
    }

    setHoverProbe(nearestDistance <= HOVER_SNAP_DISTANCE_PX ? nearestPoint : null);
  };

  const tooltipX = hoverProbe ? Math.min(WIDTH - tooltipWidth - 10, Math.max(10, hoverProbe.pointX + 12)) : 0;
  const tooltipY = hoverProbe ? Math.min(HEIGHT - tooltipHeight - 10, Math.max(10, hoverProbe.pointY - tooltipHeight - 10)) : 0;
  const statusTitle =
    player.pitchStatus === 'loading'
      ? 'Analyzing pitch contour'
      : player.pitchStatus === 'error'
        ? 'Pitch analysis unavailable'
        : 'Pitch analysis pending';
  const statusDetail =
    player.pitchStatus === 'loading'
      ? 'The line will appear automatically when analysis finishes.'
      : player.pitchStatus === 'error'
        ? 'Try reloading the source or switching stems.'
        : 'Open media or change the pitch source to begin.';

  return (
    <svg
      className="pitch-overlay"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${player.name} pitch graph`}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <rect x="0" y="0" width={WIDTH} height={HEIGHT} rx="22" className="pitch-graph__background" />

      {timeTicks.map((tick) => (
        <g key={tick}>
          <line
            x1={toX(tick)}
            y1={TOP_GUTTER}
            x2={toX(tick)}
            y2={HEIGHT - BOTTOM_GUTTER}
            className="pitch-graph__grid pitch-graph__grid--vertical"
          />
        </g>
      ))}

      {noteTicks.map((midi) => (
        <g key={midi}>
          <line
            x1={LEFT_GUTTER}
            y1={toY(midi)}
            x2={WIDTH - RIGHT_GUTTER}
            y2={toY(midi)}
            className={`pitch-graph__grid ${Math.round(midi) % 12 === 0 ? 'pitch-graph__grid--major' : Math.round(midi) % 3 === 0 ? 'pitch-graph__grid--medium' : ''}`}
          />
          <text
            x={LEFT_GUTTER - 8}
            y={toY(midi) + 4}
            textAnchor="end"
            className={`pitch-graph__label ${Math.round(midi) % 12 === 0 ? 'pitch-graph__label--major' : ''}`}
          >
            {midiToNoteLabel(midi)}
          </text>
        </g>
      ))}

      {timeTicks.map((tick) => (
        <text
          key={`label-${tick}`}
          x={toX(tick)}
          y={HEIGHT - 12}
          textAnchor="middle"
          dominantBaseline="ideographic"
          className="pitch-graph__time-label"
        >
          {tick.toFixed(1)}s
        </text>
      ))}

      {segments.map((path, index) => (
        <g key={`${player.id}-${index}`}>
          <path
            d={path}
            fill="none"
            stroke={player.lineColor}
            strokeWidth={player.lineWidth * 1.55}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={effectiveGlowOpacity}
            filter="url(#pitch-glow)"
          />
          <path
            d={path}
            fill="none"
            stroke={player.lineColor}
            strokeWidth={player.lineWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={effectiveLineOpacity}
          />
        </g>
      ))}

      {hoverProbe ? (
        <g className="pitch-graph__probe" pointerEvents="none">
          <line x1={hoverProbe.pointX} y1={TOP_GUTTER} x2={hoverProbe.pointX} y2={HEIGHT - BOTTOM_GUTTER} className="pitch-graph__probe-line" />
          <line x1={LEFT_GUTTER} y1={hoverProbe.pointY} x2={WIDTH - RIGHT_GUTTER} y2={hoverProbe.pointY} className="pitch-graph__probe-line" />
          <circle cx={hoverProbe.pointX} cy={hoverProbe.pointY} r="4.5" className="pitch-graph__probe-dot" />
          <g transform={`translate(${tooltipX}, ${tooltipY})`}>
            <rect width={tooltipWidth} height={tooltipHeight} rx="12" className="pitch-graph__probe-tooltip" />
            <text x="12" y="17" className="pitch-graph__probe-text pitch-graph__probe-text--strong">
              {midiToNoteLabel(hoverProbe.midi)}
            </text>
            <text x="12" y="33" className="pitch-graph__probe-text">
              {hoverProbe.timeSec.toFixed(3)}s · {hoverProbe.midi.toFixed(2)} st
            </text>
          </g>
        </g>
      ) : null}

      {player.pitchStatus !== 'ready' ? (
        <g className="pitch-graph__status-group" pointerEvents="none">
          <rect x="0" y="0" width={WIDTH} height={HEIGHT} rx="22" className="pitch-graph__status-wash" />
          <rect x="236" y="164" width="348" height="92" rx="18" className="pitch-graph__status-card" />
          <text x="410" y="198" textAnchor="middle" className="pitch-graph__status-title">
            {statusTitle}
          </text>
          <text x="410" y="220" textAnchor="middle" className="pitch-graph__status-detail">
            {statusDetail}
          </text>
        </g>
      ) : null}

      <defs>
        <filter id="pitch-glow">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
    </svg>
  );
}