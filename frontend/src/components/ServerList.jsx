import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Server, Trash2, ChevronRight, Plus, Home, Cpu, MemoryStick, HardDrive } from 'lucide-react';
import { fetchServerStats } from '../api';

function MiniBar({ percent, color }) {
  return (
    <div className="w-12 h-1.5 bg-dark-800 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }}
      />
    </div>
  );
}

function getBarColor(percent) {
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 70) return 'bg-orange-500';
  if (percent >= 50) return 'bg-yellow-500';
  return 'bg-green-500';
}

function getTextColor(percent) {
  if (percent >= 90) return 'text-red-400';
  if (percent >= 70) return 'text-orange-400';
  if (percent >= 50) return 'text-yellow-400';
  return 'text-green-400';
}

function ServerStats({ stats }) {
  if (!stats || stats.error) {
    return null;
  }

  return (
    <div className="flex items-center gap-2.5 mt-1.5">
      {/* CPU */}
      <div className="flex items-center gap-1" title={`CPU: ${stats.cpu_percent}% — Load: ${stats.load_avg?.join(', ')} — ${stats.cpu_cores} cores`}>
        <span className="text-[9px] text-gray-600 w-5">CPU</span>
        <MiniBar percent={stats.cpu_percent} color={getBarColor(stats.cpu_percent)} />
        <span className={`text-[9px] font-mono w-7 text-right ${getTextColor(stats.cpu_percent)}`}>
          {Math.round(stats.cpu_percent)}%
        </span>
      </div>

      {/* RAM */}
      <div className="flex items-center gap-1" title={`RAM: ${stats.mem_used_mb} / ${stats.mem_total_mb} MB (${stats.mem_percent}%)`}>
        <span className="text-[9px] text-gray-600 w-5">RAM</span>
        <MiniBar percent={stats.mem_percent} color={getBarColor(stats.mem_percent)} />
        <span className={`text-[9px] font-mono w-7 text-right ${getTextColor(stats.mem_percent)}`}>
          {Math.round(stats.mem_percent)}%
        </span>
      </div>

      {/* Swap */}
      {stats.swap_total_mb > 0 && (
        <div className="flex items-center gap-1" title={`Swap: ${stats.swap_used_mb} / ${stats.swap_total_mb} MB (${stats.swap_percent}%)`}>
          <span className="text-[9px] text-gray-600 w-5">SWP</span>
          <MiniBar percent={stats.swap_percent} color={getBarColor(stats.swap_percent)} />
          <span className={`text-[9px] font-mono w-7 text-right ${getTextColor(stats.swap_percent)}`}>
            {Math.round(stats.swap_percent)}%
          </span>
        </div>
      )}
    </div>
  );
}

export default function ServerList({ servers, selectedServer, onSelect, onDelete, onAdd }) {
  const [statsMap, setStatsMap] = useState({});
  const intervalRef = useRef(null);

  const loadAllStats = useCallback(async () => {
    if (servers.length === 0) return;

    const results = {};
    await Promise.all(
      servers.map(async (server) => {
        const stats = await fetchServerStats(server.id);
        if (stats) {
          results[server.id] = stats;
        }
      })
    );

    setStatsMap((prev) => ({ ...prev, ...results }));
  }, [servers]);

  useEffect(() => {
    loadAllStats();

    intervalRef.current = setInterval(loadAllStats, 30000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [loadAllStats]);

  return (
    <div className="w-80 flex-shrink-0 card flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-dark-700">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Servers</h2>
          <button
            onClick={onAdd}
            className="p-1.5 hover:bg-dark-800 rounded-lg transition-colors group"
            title="Add a server"
          >
            <Plus className="w-4 h-4 text-gray-500 group-hover:text-blue-400 transition-colors" />
          </button>
        </div>
      </div>

      {/* Server list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {servers.length === 0 && (
          <div className="text-center py-8 px-4">
            <Server className="w-10 h-10 text-dark-600 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No servers added</p>
            <p className="text-xs text-gray-600 mt-1">Click + to get started</p>
          </div>
        )}

        {servers.map((server) => {
          const isLocal = server.id === 'local';
          const isSelected = selectedServer?.id === server.id;
          const stats = statsMap[server.id];

          return (
            <div
              key={server.id}
              onClick={() => onSelect(server)}
              className={`group flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all duration-150 ${
                isSelected
                  ? isLocal
                    ? 'bg-green-600/15 border border-green-500/30'
                    : 'bg-blue-600/15 border border-blue-500/30'
                  : 'hover:bg-dark-800 border border-transparent'
              }`}
            >
              <div className={`p-1.5 rounded-md self-start mt-0.5 ${
                isSelected
                  ? isLocal ? 'bg-green-600/20' : 'bg-blue-600/20'
                  : 'bg-dark-700'
              }`}>
                {isLocal ? (
                  <Home className={`w-4 h-4 ${
                    isSelected ? 'text-green-400' : 'text-gray-500'
                  }`} />
                ) : (
                  <Server className={`w-4 h-4 ${
                    isSelected ? 'text-blue-400' : 'text-gray-500'
                  }`} />
                )}
              </div>
              
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className={`text-sm font-medium truncate ${
                    isSelected
                      ? isLocal ? 'text-green-300' : 'text-blue-300'
                      : 'text-gray-300'
                  }`}>
                    {server.name}
                  </p>
                  {isLocal && (
                    <span className="text-[10px] font-medium bg-green-600/20 text-green-400 px-1.5 py-0.5 rounded-full">
                      LOCAL
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 truncate">
                  {isLocal ? 'Local Docker' : `${server.user}@${server.host}:${server.port}`}
                </p>
                {!isLocal && server.key_path && (
                  <p className="text-xs text-gray-600 truncate" title={server.key_path}>
                    🔑 {server.key_path.split('/').pop()}
                  </p>
                )}

                {/* System stats */}
                <ServerStats stats={stats} />
              </div>

              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity self-start mt-1">
                {!isLocal && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(server.id); }}
                    className="p-1 hover:bg-red-600/20 rounded transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-gray-500 hover:text-red-400" />
                  </button>
                )}
                <ChevronRight className="w-4 h-4 text-gray-600" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
