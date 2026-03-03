import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Radio, RefreshCw, Loader2, Search, ArrowDown, Download, Trash2,
  Filter, XCircle, AlertTriangle, Info, Bug, Box, Pause, Play,
} from 'lucide-react';
import { fetchAllLogs, createAllLogsWebSocket } from '../api';
import { formatLocalTimestamp } from '../utils/formatTimestamp';

const LEVEL_CONFIG = {
  error: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10', label: 'Error' },
  warn: { icon: AlertTriangle, color: 'text-yellow-400', bg: 'bg-yellow-500/10', label: 'Warning' },
  info: { icon: Info, color: 'text-blue-400', bg: 'bg-blue-500/10', label: 'Info' },
  debug: { icon: Bug, color: 'text-gray-400', bg: 'bg-gray-500/10', label: 'Debug' },
};

// Distinct colors for each container
const CONTAINER_COLORS = [
  'text-cyan-400',
  'text-purple-400',
  'text-emerald-400',
  'text-pink-400',
  'text-amber-400',
  'text-sky-400',
  'text-lime-400',
  'text-fuchsia-400',
  'text-teal-400',
  'text-orange-400',
  'text-indigo-400',
  'text-rose-400',
  'text-violet-400',
  'text-green-400',
  'text-blue-300',
];

const CONTAINER_BG_COLORS = [
  'bg-cyan-500/10',
  'bg-purple-500/10',
  'bg-emerald-500/10',
  'bg-pink-500/10',
  'bg-amber-500/10',
  'bg-sky-500/10',
  'bg-lime-500/10',
  'bg-fuchsia-500/10',
  'bg-teal-500/10',
  'bg-orange-500/10',
  'bg-indigo-500/10',
  'bg-rose-500/10',
  'bg-violet-500/10',
  'bg-green-500/10',
  'bg-blue-500/10',
];

export default function LiveView({ server }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [paused, setPaused] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterLevel, setFilterLevel] = useState('all');
  const [filterContainers, setFilterContainers] = useState(new Set());
  const [showContainerFilter, setShowContainerFilter] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [error, setError] = useState(null);
  const logsContainerRef = useRef(null);
  const wsRef = useRef(null);
  const pausedRef = useRef(false);
  const bufferRef = useRef([]);
  const prevServerRef = useRef(null);

  const containerColorMap = useRef(new Map());
  const colorIndexRef = useRef(0);

  const getContainerColor = (name) => {
    if (!name) return { text: 'text-gray-400', bg: 'bg-gray-500/10' };
    if (!containerColorMap.current.has(name)) {
      const idx = colorIndexRef.current % CONTAINER_COLORS.length;
      containerColorMap.current.set(name, idx);
      colorIndexRef.current++;
    }
    const idx = containerColorMap.current.get(name);
    return { text: CONTAINER_COLORS[idx], bg: CONTAINER_BG_COLORS[idx] };
  };

  const uniqueContainers = useMemo(() => {
    const names = new Set();
    logs.forEach((l) => { if (l.container_name) names.add(l.container_name); });
    return Array.from(names).sort();
  }, [logs]);

  const loadLogs = useCallback(async () => {
    if (!server) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAllLogs(server.id, 30);
      setLogs(data.reverse());
    } catch (e) {
      console.error('Error loading logs:', e);
      setError(`Failed to retrieve logs: ${e.message}`);
    }
    setLoading(false);
    setSwitching(false);
  }, [server]);

  useEffect(() => {
    // Detect server switch → trigger blur
    if (prevServerRef.current && prevServerRef.current !== server?.id) {
      setSwitching(true);
    }
    prevServerRef.current = server?.id;

    loadLogs();
    return () => stopStreaming();
  }, [loadLogs]);

  useEffect(() => {
    if (autoScroll && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = 0;
    }
  }, [logs, autoScroll]);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && bufferRef.current.length > 0) {
      setLogs((prev) => [...bufferRef.current.reverse(), ...prev].slice(0, 2000));
      bufferRef.current = [];
    }
  }, [paused]);

  const startStreaming = () => {
    if (wsRef.current) return;
    setError(null);
    const ws = createAllLogsWebSocket(server.id);
    ws.onopen = () => {
      setStreaming(true);
      setError(null);
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.error) {
        setError(`WebSocket error: ${data.error}`);
        return;
      }
      if (data.log) {
        if (pausedRef.current) {
          bufferRef.current.push(data.log);
        } else {
          setLogs((prev) => [data.log, ...prev.slice(0, 1999)]);
        }
      }
    };
    ws.onclose = () => {
      wsRef.current = null;
      setStreaming(false);
    };
    ws.onerror = () => {
      wsRef.current = null;
      setStreaming(false);
      setError('WebSocket connection lost. The server may be unreachable.');
    };
    wsRef.current = ws;
  };

  const stopStreaming = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStreaming(false);
  };

  const toggleStreaming = () => {
    if (streaming) stopStreaming();
    else startStreaming();
  };

  const exportLogs = () => {
    const text = filteredLogs.map((l) => {
      const prefix = l.container_name ? `[${l.container_name}] ` : '';
      return prefix + (l.raw || l.message);
    }).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `live-logs-${server.name}-${new Date().toISOString().slice(0, 19)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredLogs = logs.filter((log) => {
    if (filterLevel !== 'all' && log.level !== filterLevel) return false;
    if (filterContainers.size > 0 && log.container_name && !filterContainers.has(log.container_name)) return false;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      return (log.message || '').toLowerCase().includes(term) ||
             (log.container_name || '').toLowerCase().includes(term) ||
             (log.raw || '').toLowerCase().includes(term);
    }
    return true;
  });

  const toggleContainerFilter = (name) => {
    setFilterContainers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  if (!server) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <Radio className="w-16 h-16 text-dark-700 mx-auto mb-4" />
          <p className="text-gray-500 text-lg">Select a server</p>
          <p className="text-gray-600 text-sm mt-1">to view real-time logs</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 card flex flex-col h-full overflow-hidden relative">
      {/* Blur overlay during server switch */}
      {switching && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-dark-900/40 backdrop-blur-sm transition-all duration-300 animate-fade-in">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-green-400 animate-spin" />
            <span className="text-sm text-gray-300 font-medium">Loading {server.name}…</span>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="p-4 border-b border-dark-700 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Radio className={`w-4 h-4 ${streaming ? 'text-green-400 animate-pulse-dot' : 'text-gray-500'}`} />
              <h2 className="text-sm font-semibold text-gray-300">
                Live — <span className="text-green-400">{server.name}</span>
              </h2>
            </div>
            <span className="text-xs text-gray-500 bg-dark-800 px-2 py-0.5 rounded-full">
              All containers
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={toggleStreaming}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                streaming
                  ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30'
                  : 'bg-green-600/20 text-green-400 hover:bg-green-600/30'
              }`}
            >
              <Radio className={`w-3 h-3 ${streaming ? 'animate-pulse-dot' : ''}`} />
              {streaming ? 'Stop' : 'Live stream'}
            </button>
            {streaming && (
              <button
                onClick={() => setPaused(!paused)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  paused
                    ? 'bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30'
                    : 'bg-dark-800 text-gray-400 hover:bg-dark-700'
                }`}
                title={paused ? 'Resume' : 'Pause'}
              >
                {paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                {paused ? `Resume (${bufferRef.current.length})` : 'Pause'}
              </button>
            )}
            <button onClick={loadLogs} disabled={loading} className="btn-ghost p-1.5" title="Refresh">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </button>
            <button onClick={exportLogs} className="btn-ghost p-1.5" title="Export">
              <Download className="w-4 h-4" />
            </button>
            <button onClick={() => setLogs([])} className="btn-ghost p-1.5" title="Clear">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search & Filters */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search logs..."
              className="input w-full pl-9 py-1.5 text-sm"
            />
          </div>

          {/* Level filter */}
          <div className="flex items-center gap-1 bg-dark-800 rounded-lg p-0.5">
            <button
              onClick={() => setFilterLevel('all')}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                filterLevel === 'all' ? 'bg-dark-600 text-gray-200' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              All
            </button>
            {Object.entries(LEVEL_CONFIG).map(([level, config]) => (
              <button
                key={level}
                onClick={() => setFilterLevel(level)}
                className={`px-2 py-1 text-xs rounded-md transition-colors flex items-center gap-1 ${
                  filterLevel === level ? `${config.bg} ${config.color}` : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <config.icon className="w-3 h-3" />
                {config.label}
              </button>
            ))}
          </div>

          {/* Container filter toggle */}
          <button
            onClick={() => setShowContainerFilter(!showContainerFilter)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-lg transition-colors ${
              filterContainers.size > 0
                ? 'bg-blue-600/20 text-blue-400'
                : 'bg-dark-800 text-gray-500 hover:text-gray-300'
            }`}
          >
            <Filter className="w-3 h-3" />
            <span>Containers</span>
            {filterContainers.size > 0 && (
              <span className="bg-blue-600/30 px-1.5 rounded-full text-[10px]">{filterContainers.size}</span>
            )}
          </button>
        </div>

        {/* Container filter panel */}
        {showContainerFilter && (
          <div className="flex flex-wrap gap-1.5 animate-fade-in">
            <button
              onClick={() => setFilterContainers(new Set())}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                filterContainers.size === 0 ? 'bg-dark-600 text-gray-200' : 'bg-dark-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              All
            </button>
            {uniqueContainers.map((name) => {
              const colors = getContainerColor(name);
              const active = filterContainers.has(name);
              return (
                <button
                  key={name}
                  onClick={() => toggleContainerFilter(name)}
                  className={`px-2 py-1 text-xs rounded-md transition-colors truncate max-w-[180px] ${
                    active ? `${colors.bg} ${colors.text}` : 'bg-dark-800 text-gray-500 hover:text-gray-300'
                  }`}
                  title={name}
                >
                  {name.length > 25 ? name.slice(0, 25) + '…' : name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Logs content */}
      <div
        ref={logsContainerRef}
        className="flex-1 overflow-y-auto font-mono text-xs"
        onScroll={(e) => {
          const el = e.target;
          const atTop = el.scrollTop < 50;
          setAutoScroll(atTop);
        }}
      >
        {loading && logs.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-gray-500 animate-spin" />
          </div>
        )}

        {filteredLogs.map((log, idx) => (
          <LiveLogLine key={idx} log={log} searchTerm={searchTerm} getContainerColor={getContainerColor} />
        ))}

        {!loading && filteredLogs.length === 0 && logs.length > 0 && (
          <div className="text-center py-8 text-gray-500 text-sm">
            No logs match the filters
          </div>
        )}

        {error && (
          <div className="mx-4 mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
            <div className="flex items-start gap-3">
              <XCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-red-300">Connection error</p>
                <p className="text-xs text-red-400/80 mt-1">{error}</p>
                <button
                  onClick={loadLogs}
                  className="mt-2 text-xs px-3 py-1 bg-red-600/20 text-red-300 rounded-md hover:bg-red-600/30 transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          </div>
        )}

        {!loading && !error && logs.length === 0 && (
          <div className="text-center py-8">
            <Box className="w-10 h-10 text-dark-600 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">Click "Live stream" to start</p>
          </div>
        )}

      </div>

      {/* Scroll to top button */}
      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true);
            if (logsContainerRef.current) logsContainerRef.current.scrollTop = 0;
          }}
          className="absolute bottom-12 right-4 btn-primary p-2 rounded-full shadow-lg"
          title="Scroll to recent logs"
        >
          <ArrowDown className="w-4 h-4 rotate-180" />
        </button>
      )}

      {/* Footer */}
      <div className="px-4 py-2 border-t border-dark-700 flex items-center justify-between text-xs text-gray-500">
        <span>{filteredLogs.length} / {logs.length} lines — {uniqueContainers.length} containers</span>
        <div className="flex items-center gap-3">
          {paused && (
            <span className="flex items-center gap-1 text-yellow-400">
              <Pause className="w-3 h-3" />
              Paused — {bufferRef.current.length} pending
            </span>
          )}
          {streaming && !paused && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse-dot" />
              Streaming
            </span>
          )}
        </div>
      </div>
    </div>
  );
}


function LiveLogLine({ log, searchTerm, getContainerColor }) {
  const [expanded, setExpanded] = useState(false);

  const highlightText = (text, term) => {
    if (!term || !text) return text;
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part)
        ? <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded px-0.5">{part}</mark>
        : part
    );
  };

  const levelConfig = LEVEL_CONFIG[log.level] || LEVEL_CONFIG.info;
  const LevelIcon = levelConfig.icon;
  const containerColors = getContainerColor(log.container_name);

  return (
    <div
      className={`log-line level-${log.level} hover:bg-dark-800/50 cursor-pointer group`}
      onClick={() => log.json_data && setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2 py-0.5">
        <LevelIcon className={`w-3 h-3 mt-0.5 flex-shrink-0 ${levelConfig.color}`} />

        {/* Container name badge */}
        {log.container_name && (
          <span
            className={`text-[10px] font-semibold px-1.5 py-0 rounded ${containerColors.bg} ${containerColors.text} flex-shrink-0 truncate max-w-[150px]`}
            title={log.container_name}
          >
            {log.container_name.length > 20 ? log.container_name.slice(0, 20) + '…' : log.container_name}
          </span>
        )}

        {log.timestamp && (
          <span className="text-gray-600 flex-shrink-0 select-none text-[11px]" title={`UTC: ${log.timestamp}`}>
            {formatLocalTimestamp(log.timestamp, 'time')}
          </span>
        )}

        <span className="flex-1 break-all whitespace-pre-wrap">
          {highlightText(log.message, searchTerm)}
        </span>

        {log.json_data && (
          <span className="text-xs text-dark-400 group-hover:text-gray-400 flex-shrink-0">
            {expanded ? '▼' : '▶'} JSON
          </span>
        )}
      </div>
      {expanded && log.json_data && (
        <pre className="mt-1 ml-5 p-2 bg-dark-950 rounded text-green-300 text-xs overflow-x-auto">
          {JSON.stringify(log.json_data, null, 2)}
        </pre>
      )}
    </div>
  );
}
