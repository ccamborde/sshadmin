import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  FileText, RefreshCw, Loader2, Search, ArrowDown,
  Filter, Download, Trash2, Radio, XCircle, AlertTriangle,
  Info, Bug
} from 'lucide-react';
import { fetchLogs, createLogWebSocket } from '../api';
import { formatLocalTimestamp } from '../utils/formatTimestamp';

const LEVEL_CONFIG = {
  error: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10', label: 'Error' },
  warn: { icon: AlertTriangle, color: 'text-yellow-400', bg: 'bg-yellow-500/10', label: 'Warning' },
  info: { icon: Info, color: 'text-blue-400', bg: 'bg-blue-500/10', label: 'Info' },
  debug: { icon: Bug, color: 'text-gray-400', bg: 'bg-gray-500/10', label: 'Debug' },
};

export default function LogViewer({ server, container }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterLevel, setFilterLevel] = useState('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [tail, setTail] = useState(200);
  const logsContainerRef = useRef(null);
  const wsRef = useRef(null);

  const loadLogs = useCallback(async () => {
    if (!server || !container) return;
    setLoading(true);
    try {
      const data = await fetchLogs(server.id, container.id, tail);
      setLogs(data.reverse());
    } catch (e) {
      console.error('Error loading logs:', e);
    }
    setLoading(false);
  }, [server, container, tail]);

  useEffect(() => {
    loadLogs();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [loadLogs]);

  useEffect(() => {
    if (autoScroll && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = 0;
    }
  }, [logs, autoScroll]);

  const toggleStreaming = () => {
    if (streaming) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setStreaming(false);
    } else {
      const ws = createLogWebSocket(server.id, container.id);
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.log) {
          setLogs((prev) => [data.log, ...prev.slice(0, 999)]);
        }
      };
      ws.onclose = () => setStreaming(false);
      ws.onerror = () => setStreaming(false);
      wsRef.current = ws;
      setStreaming(true);
    }
  };

  const exportLogs = () => {
    const text = filteredLogs.map(l => l.raw || l.message).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${container.name}-${new Date().toISOString().slice(0, 19)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredLogs = logs.filter((log) => {
    if (filterLevel !== 'all' && log.level !== filterLevel) return false;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      return (log.message || '').toLowerCase().includes(term) ||
             (log.raw || '').toLowerCase().includes(term);
    }
    return true;
  });

  if (!container) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <FileText className="w-16 h-16 text-dark-700 mx-auto mb-4" />
          <p className="text-gray-500 text-lg">Select a container</p>
          <p className="text-gray-600 text-sm mt-1">to view its Docker logs</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 card flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-dark-700 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-300">
              Logs — <span className="text-blue-400">{container.name}</span>
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">{container.image}</p>
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
              {streaming ? 'Stop stream' : 'Live stream'}
            </button>
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

          {/* Level filter pills */}
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

          {/* Tail size */}
          <select
            value={tail}
            onChange={(e) => setTail(Number(e.target.value))}
            className="input py-1.5 text-xs w-20"
          >
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
            <option value={1000}>1000</option>
          </select>
        </div>
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
          <LogLine key={idx} log={log} searchTerm={searchTerm} />
        ))}

        {!loading && filteredLogs.length === 0 && logs.length > 0 && (
          <div className="text-center py-8 text-gray-500 text-sm">
            No logs match the filter
          </div>
        )}

        {!loading && logs.length === 0 && (
          <div className="text-center py-8 text-gray-500 text-sm">
            No logs available
          </div>
        )}

      </div>

      {/* Scroll to recent logs button */}
      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true);
            if (logsContainerRef.current) logsContainerRef.current.scrollTop = 0;
          }}
          className="absolute bottom-4 right-4 btn-primary p-2 rounded-full shadow-lg"
          title="Scroll to recent logs"
        >
          <ArrowDown className="w-4 h-4 rotate-180" />
        </button>
      )}

      <div className="px-4 py-2 border-t border-dark-700 flex items-center justify-between text-xs text-gray-500">
        <span>{filteredLogs.length} / {logs.length} lines</span>
        {streaming && (
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse-dot" />
            Streaming
          </span>
        )}
      </div>
    </div>
  );
}


function LogLine({ log, searchTerm }) {
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

  return (
    <div
      className={`log-line level-${log.level} hover:bg-dark-800/50 cursor-pointer group`}
      onClick={() => log.json_data && setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2 py-0.5">
        <LevelIcon className={`w-3 h-3 mt-0.5 flex-shrink-0 ${levelConfig.color}`} />
        {log.timestamp && (
          <span className="text-gray-500 flex-shrink-0 select-none" title={`UTC: ${log.timestamp}`}>
            {formatLocalTimestamp(log.timestamp, 'datetime')}
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
