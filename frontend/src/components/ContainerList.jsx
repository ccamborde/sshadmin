import React, { useState } from 'react';
import { Box, RefreshCw, Loader2 } from 'lucide-react';
import ContainerContextMenu from './ContainerContextMenu';

const stateColors = {
  running: 'text-green-400',
  exited: 'text-red-400',
  paused: 'text-yellow-400',
  restarting: 'text-orange-400',
  created: 'text-gray-400',
  dead: 'text-red-500',
};

const stateBgColors = {
  running: 'bg-green-400',
  exited: 'bg-red-400',
  paused: 'bg-yellow-400',
  restarting: 'bg-orange-400',
  created: 'bg-gray-400',
  dead: 'bg-red-500',
};

export default function ContainerList({
  server,
  containers,
  loading,
  selectedContainer,
  onSelect,
  onRefresh,
}) {
  const [contextMenu, setContextMenu] = useState(null);

  if (!server) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <Box className="w-16 h-16 text-dark-700 mx-auto mb-4" />
          <p className="text-gray-500 text-lg">Select a server</p>
          <p className="text-gray-600 text-sm mt-1">to view its Docker containers</p>
        </div>
      </div>
    );
  }

  const handleContextMenu = (e, container) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      container,
    });
  };

  const handleActionDone = (action) => {
    onRefresh();
  };

  return (
    <div className="w-80 flex-shrink-0 card flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-dark-700">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Containers</h2>
            <p className="text-xs text-gray-500 mt-0.5">{server.name}</p>
          </div>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="p-1.5 hover:bg-dark-800 rounded-lg transition-colors"
            title="Refresh"
          >
            {loading 
              ? <Loader2 className="w-4 h-4 text-gray-500 animate-spin" />
              : <RefreshCw className="w-4 h-4 text-gray-500 hover:text-gray-300" />
            }
          </button>
        </div>
      </div>

      {/* Container list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loading && containers.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 text-gray-500 animate-spin" />
          </div>
        )}

        {!loading && containers.length === 0 && (
          <div className="text-center py-8 px-4">
            <Box className="w-10 h-10 text-dark-600 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No containers found</p>
          </div>
        )}

        {containers.map((container) => (
          <div
            key={container.id}
            onClick={() => onSelect(container)}
            onContextMenu={(e) => handleContextMenu(e, container)}
            className={`group p-3 rounded-lg cursor-pointer transition-all duration-150 ${
              selectedContainer?.id === container.id
                ? 'bg-blue-600/15 border border-blue-500/30'
                : 'hover:bg-dark-800 border border-transparent'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2 h-2 rounded-full ${stateBgColors[container.state] || 'bg-gray-500'} ${
                container.state === 'running' ? 'animate-pulse-dot' : ''
              }`} />
              <p className={`text-sm font-medium truncate ${
                selectedContainer?.id === container.id ? 'text-blue-300' : 'text-gray-300'
              }`}>
                {container.name}
              </p>
            </div>
            <div className="ml-4 space-y-0.5">
              <p className="text-xs text-gray-500 truncate" title={container.image}>
                {container.image}
              </p>
              <p className={`text-xs ${stateColors[container.state] || 'text-gray-500'}`}>
                {container.status}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Right-click tooltip */}
      {containers.length > 0 && (
        <div className="px-3 py-1.5 border-t border-dark-700">
          <p className="text-[10px] text-gray-600 text-center">Right-click a container for actions</p>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContainerContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          container={contextMenu.container}
          serverId={server.id}
          onClose={() => setContextMenu(null)}
          onActionDone={handleActionDone}
        />
      )}
    </div>
  );
}
