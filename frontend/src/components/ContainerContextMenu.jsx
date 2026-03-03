import React, { useEffect, useRef, useState } from 'react';
import {
  Play, Square, RotateCcw, Skull, Pause, PlayCircle,
  Trash2, Info, Loader2, CheckCircle2, XCircle,
} from 'lucide-react';
import { dockerAction, dockerInspect } from '../api';

const ACTIONS = [
  { type: 'divider', label: 'Lifecycle' },
  {
    key: 'start',
    label: 'Start',
    icon: Play,
    color: 'text-green-400',
    hoverBg: 'hover:bg-green-500/10',
    showWhen: (s) => s !== 'running',
  },
  {
    key: 'stop',
    label: 'Stop',
    icon: Square,
    color: 'text-orange-400',
    hoverBg: 'hover:bg-orange-500/10',
    showWhen: (s) => s === 'running',
    confirm: 'Stop this container?',
  },
  {
    key: 'restart',
    label: 'Restart',
    icon: RotateCcw,
    color: 'text-blue-400',
    hoverBg: 'hover:bg-blue-500/10',
    showWhen: (s) => s === 'running',
  },
  { type: 'divider', label: 'Control' },
  {
    key: 'pause',
    label: 'Pause',
    icon: Pause,
    color: 'text-yellow-400',
    hoverBg: 'hover:bg-yellow-500/10',
    showWhen: (s) => s === 'running',
  },
  {
    key: 'unpause',
    label: 'Resume',
    icon: PlayCircle,
    color: 'text-green-400',
    hoverBg: 'hover:bg-green-500/10',
    showWhen: (s) => s === 'paused',
  },
  { type: 'divider', label: 'Dangerous' },
  {
    key: 'kill',
    label: 'Kill (SIGKILL)',
    icon: Skull,
    color: 'text-red-400',
    hoverBg: 'hover:bg-red-500/10',
    showWhen: (s) => s === 'running',
    confirm: 'Force kill this container (SIGKILL)?',
  },
  {
    key: 'remove',
    label: 'Remove',
    icon: Trash2,
    color: 'text-red-500',
    hoverBg: 'hover:bg-red-500/10',
    showWhen: () => true,
    confirm: 'Permanently remove this container?',
  },
];

export default function ContainerContextMenu({
  x,
  y,
  container,
  serverId,
  onClose,
  onActionDone,
}) {
  const menuRef = useRef(null);
  const [loading, setLoading] = useState(null);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const menuStyle = {
    position: 'fixed',
    zIndex: 100,
    left: x,
    top: y,
  };

  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menuRef.current.style.left = `${x - rect.width}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menuRef.current.style.top = `${y - rect.height}px`;
      }
    }
  }, [x, y]);

  const handleAction = async (action) => {
    if (action.confirm && !confirm(action.confirm)) return;

    setLoading(action.key);
    setFeedback(null);
    try {
      await dockerAction(serverId, container.id, action.key);
      setFeedback({ success: true, message: `${action.label} — OK` });
      setTimeout(() => {
        onActionDone(action.key);
        onClose();
      }, 600);
    } catch (e) {
      setFeedback({ success: false, message: e.message });
      setLoading(null);
    }
  };

  const handleInspect = async () => {
    setLoading('inspect');
    try {
      const data = await dockerInspect(serverId, container.id);
      const win = window.open('', '_blank', 'width=800,height=600');
      win.document.write(`
        <html>
          <head>
            <title>Inspect — ${container.name}</title>
            <style>
              body { background: #111214; color: #e2e3e5; font-family: monospace; padding: 20px; margin: 0; }
              pre { white-space: pre-wrap; word-wrap: break-word; font-size: 13px; line-height: 1.5; }
              h1 { font-size: 16px; color: #60a5fa; margin-bottom: 16px; }
            </style>
          </head>
          <body>
            <h1>🔍 docker inspect ${container.name}</h1>
            <pre>${JSON.stringify(data, null, 2)}</pre>
          </body>
        </html>
      `);
      win.document.close();
      onClose();
    } catch (e) {
      setFeedback({ success: false, message: e.message });
    }
    setLoading(null);
  };

  const visibleActions = ACTIONS.filter((a) => {
    if (a.type === 'divider') return true;
    return a.showWhen(container.state);
  });

  const cleaned = [];
  for (let i = 0; i < visibleActions.length; i++) {
    const current = visibleActions[i];
    const next = visibleActions[i + 1];
    if (current.type === 'divider') {
      if (!next || next.type === 'divider') continue;
    }
    cleaned.push(current);
  }

  return (
    <div ref={menuRef} style={menuStyle} className="animate-fade-in">
      <div className="bg-dark-900 border border-dark-600 rounded-xl shadow-2xl py-1 min-w-[220px] overflow-hidden">
        {/* Header */}
        <div className="px-3 py-2 border-b border-dark-700">
          <p className="text-xs font-semibold text-gray-300 truncate">{container.name}</p>
          <p className="text-xs text-gray-500">{container.image}</p>
        </div>

        {/* Actions */}
        <div className="py-1">
          {cleaned.map((action, idx) => {
            if (action.type === 'divider') {
              return (
                <div key={`div-${idx}`} className="px-3 py-1.5">
                  <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider">
                    {action.label}
                  </p>
                </div>
              );
            }

            const Icon = action.icon;
            const isLoading = loading === action.key;

            return (
              <button
                key={action.key}
                onClick={() => handleAction(action)}
                disabled={loading !== null}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-gray-300
                  ${action.hoverBg} transition-colors disabled:opacity-40 cursor-pointer`}
              >
                {isLoading
                  ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                  : <Icon className={`w-4 h-4 ${action.color}`} />
                }
                <span>{action.label}</span>
              </button>
            );
          })}
        </div>

        {/* Inspect */}
        <div className="border-t border-dark-700 py-1">
          <button
            onClick={handleInspect}
            disabled={loading !== null}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-gray-300
              hover:bg-dark-800 transition-colors disabled:opacity-40 cursor-pointer"
          >
            {loading === 'inspect'
              ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
              : <Info className="w-4 h-4 text-gray-400" />
            }
            <span>Inspect</span>
          </button>
        </div>

        {/* Feedback */}
        {feedback && (
          <div className={`mx-2 mb-2 flex items-center gap-1.5 p-2 rounded-lg text-xs ${
            feedback.success
              ? 'bg-green-950/50 text-green-400'
              : 'bg-red-950/50 text-red-400'
          }`}>
            {feedback.success
              ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
              : <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
            }
            <span className="truncate">{feedback.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}
