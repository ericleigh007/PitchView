import { buildPitchSegments } from '../lib/pitchDisplay';
import { midiToNoteLabel } from '../lib/sync';
import type { PlayerState } from '../lib/types';

type PitchGraphProps = {
  player: PlayerState;
  focusTimeSec: number;
  timeScaleSec: number;
  pitchRangeSemitones: number;
  midiCenter: number;
  emphasis?: number;
};

const WIDTH = 820;
const HEIGHT = 430;
const LEFT_GUTTER = 58;
const TOP_GUTTER = 16;
const RIGHT_GUTTER = 16;
const BOTTOM_GUTTER = 32;
const MIN_GRAPH_CONFIDENCE = 0.14;

export function PitchGraph({
  player,
  focusTimeSec,
  timeScaleSec,
  pitchRangeSemitones,
  midiCenter,
  emphasis = 1,
}: PitchGraphProps) {
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

  return (
    <svg className="pitch-overlay" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${player.name} pitch graph`}>
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
        <text key={`label-${tick}`} x={toX(tick)} y={HEIGHT - 10} textAnchor="middle" className="pitch-graph__time-label">
          {tick.toFixed(1)}s
        </text>
      ))}

      {segments.map((path, index) => (
        <g key={`${player.id}-${index}`}>
          <path
            d={path}
            fill="none"
            stroke={player.lineColor}
            strokeWidth={player.lineWidth * 2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={emphasis * 0.18}
            filter="url(#pitch-glow)"
          />
          <path
            d={path}
            fill="none"
            stroke={player.lineColor}
            strokeWidth={player.lineWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={emphasis}
          />
        </g>
      ))}

      {player.pitchStatus !== 'ready' ? <rect x="0" y="0" width={WIDTH} height={HEIGHT} rx="22" className="pitch-graph__status-wash" /> : null}

      <defs>
        <filter id="pitch-glow">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
    </svg>
  );
}