import { buildAmplitudeWindow } from '../lib/amplitudeAnalysis';
import type { AmplitudePoint } from '../lib/amplitudeAnalysis';

type AmplitudeStripProps = {
  points: AmplitudePoint[];
  playerName: string;
  focusTimeSec: number;
  timeScaleSec: number;
  color: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
};

const WIDTH = 1000;
const HEIGHT = 100;

export function AmplitudeStrip({ points, playerName, focusTimeSec, timeScaleSec, color, status }: AmplitudeStripProps) {
  const halfRange = timeScaleSec / 2;
  const rangeStart = Math.max(0, focusTimeSec - halfRange);
  const rangeEnd = rangeStart + timeScaleSec;
  const amplitudes = buildAmplitudeWindow(points, rangeStart, rangeEnd, 160);
  const columnWidth = WIDTH / Math.max(1, amplitudes.length);
  const centerY = HEIGHT / 2;
  const usableHeight = HEIGHT - 16;
  const playheadX = ((focusTimeSec - rangeStart) / Math.max(0.001, timeScaleSec)) * WIDTH;

  return (
    <svg className="amplitude-strip" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${playerName} amplitude strip`}>
      <rect x="0" y="0" width={WIDTH} height={HEIGHT} rx="14" className="amplitude-strip__background" />
      <line x1="0" y1={centerY} x2={WIDTH} y2={centerY} className="amplitude-strip__baseline" />
      {amplitudes.map((amplitude, index) => {
        const height = Math.max(2, amplitude * usableHeight);
        const x = index * columnWidth;
        const y = centerY - height / 2;

        return (
          <rect
            key={`${index}-${amplitude.toFixed(3)}`}
            x={x}
            y={y}
            width={Math.max(1, columnWidth - 0.8)}
            height={height}
            rx="1.5"
            fill={color}
            opacity={0.18 + amplitude * 0.72}
          />
        );
      })}
      <line x1={playheadX} y1="8" x2={playheadX} y2={HEIGHT - 8} className="amplitude-strip__playhead" stroke={color} />
      <text x="12" y="18" className="amplitude-strip__label">
        AMP
      </text>
      {status !== 'ready' ? (
        <text x={WIDTH - 14} y="18" textAnchor="end" className="amplitude-strip__status">
          {status === 'loading' ? 'loading' : status === 'error' ? 'unavailable' : 'pending'}
        </text>
      ) : null}
    </svg>
  );
}