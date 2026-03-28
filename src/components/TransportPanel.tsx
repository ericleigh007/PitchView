import { LockIcon } from './LockIcon';
import { MAX_LAYER_HEIGHT, MAX_LAYER_WIDTH, MIN_LAYER_HEIGHT, MIN_LAYER_WIDTH, formatClock, getAudibleState } from '../lib/sync';
import type { MixMode, PlayerState, TransportAction } from '../lib/types';

type TransportPanelProps = {
  player: PlayerState;
  players: PlayerState[];
  dispatch: React.Dispatch<TransportAction>;
  selected: boolean;
  onTogglePlay: (playerId: string) => void;
};

const mixModes: MixMode[] = ['mixed', 'muted', 'solo'];

export function TransportPanel({ player, players, dispatch, selected, onTogglePlay }: TransportPanelProps) {
  const { audible } = getAudibleState(players, player.id);

  return (
    <article className={`transport-panel ${selected ? 'transport-panel--selected' : ''}`}>
      <header className="transport-panel__header">
        <button className="transport-panel__title" onClick={() => dispatch({ type: 'select-player', playerId: player.id })}>
          <span>{player.name}</span>
          <small>{audible ? 'audible' : 'silent'}</small>
        </button>
        <button
          className={`lock-toggle ${player.isLocked ? 'lock-toggle--active' : ''}`}
          onClick={() => dispatch({ type: 'toggle-lock', playerId: player.id })}
        >
          <LockIcon locked={player.isLocked} />
          <span>{player.isLocked ? 'Locked' : 'Free'}</span>
        </button>
      </header>

      <div className="transport-panel__summary-row">
        <span>{player.isPlaying ? 'Playing' : 'Paused'}</span>
        <span>{formatClock(player.positionSec)}</span>
        <button onClick={() => onTogglePlay(player.id)}>{player.isPlaying ? 'Pause' : 'Play'}</button>
      </div>

      <div className="transport-panel__controls-grid">
        <label>
          <span>Line</span>
          <input
            type="color"
            value={player.lineColor}
            onChange={(event) =>
              dispatch({ type: 'set-line-color', playerId: player.id, lineColor: event.currentTarget.value })
            }
          />
        </label>

        <label>
          <span>Width</span>
          <input
            type="range"
            min={0.5}
            max={1.5}
            step={0.05}
            value={player.lineWidth}
            onChange={(event) =>
              dispatch({ type: 'set-line-width', playerId: player.id, lineWidth: Number(event.currentTarget.value) })
            }
          />
        </label>

        <label>
          <span>Opacity</span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={player.opacity}
            onChange={(event) =>
              dispatch({ type: 'set-opacity', playerId: player.id, opacity: Number(event.currentTarget.value) })
            }
          />
        </label>

        <label>
          <span>Layer</span>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={player.zIndex}
            onChange={(event) =>
              dispatch({ type: 'set-z-index', playerId: player.id, zIndex: Number(event.currentTarget.value) })
            }
          />
        </label>

        <label>
          <span>Width</span>
          <input
            type="range"
            min={MIN_LAYER_WIDTH}
            max={MAX_LAYER_WIDTH}
            step={20}
            value={player.width}
            onChange={(event) =>
              dispatch({ type: 'set-layer-size', playerId: player.id, width: Number(event.currentTarget.value) })
            }
          />
        </label>

        <label>
          <span>Height</span>
          <input
            type="range"
            min={MIN_LAYER_HEIGHT}
            max={MAX_LAYER_HEIGHT}
            step={20}
            value={player.height}
            onChange={(event) =>
              dispatch({ type: 'set-layer-size', playerId: player.id, height: Number(event.currentTarget.value) })
            }
          />
        </label>

        <label>
          <span>Stem</span>
          <select
            value={player.activeStemId}
            onChange={(event) =>
              dispatch({ type: 'set-active-stem', playerId: player.id, stemId: event.currentTarget.value })
            }
          >
            {player.availableStems.map((stem) => (
              <option key={stem.id} value={stem.id}>
                {stem.label}{stem.status === 'planned' ? ' (planned)' : stem.status === 'generated' ? ' (ready)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="transport-panel__transport transport-panel__transport--size">
        <button onClick={() => dispatch({ type: 'nudge-layer-size', playerId: player.id, deltaWidth: -80 })}>W-</button>
        <button onClick={() => dispatch({ type: 'nudge-layer-size', playerId: player.id, deltaWidth: 80 })}>W+</button>
        <button onClick={() => dispatch({ type: 'nudge-layer-size', playerId: player.id, deltaHeight: -60 })}>H-</button>
        <button onClick={() => dispatch({ type: 'nudge-layer-size', playerId: player.id, deltaHeight: 60 })}>H+</button>
        <button onClick={() => dispatch({ type: 'set-layer-size', playerId: player.id, width: 1120, height: 680 })}>Reset Size</button>
        <span>{player.width} x {player.height}</span>
      </div>

      <div className="transport-panel__mix-modes" role="group" aria-label={`Mix mode for ${player.name}`}>
        {mixModes.map((mode) => (
          <button
            key={mode}
            className={player.mixMode === mode ? 'is-active' : ''}
            onClick={() => dispatch({ type: 'set-mix-mode', playerId: player.id, mixMode: mode })}
          >
            {mode}
          </button>
        ))}
      </div>
    </article>
  );
}