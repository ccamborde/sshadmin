import React, { useState, useEffect, useCallback } from 'react';
import { Monitor, Terminal, Radio, Box, Database } from 'lucide-react';
import ServerList from './components/ServerList';
import ContainerList from './components/ContainerList';
import LogViewer from './components/LogViewer';
import LiveView from './components/LiveView';
import PrismaView from './components/PrismaView';
import AddServerModal from './components/AddServerModal';
import { fetchServers, deleteServer, fetchContainers } from './api';

const isElectron = !!(window.electronAPI?.isElectron);

export default function App() {
  const [servers, setServers] = useState([]);
  const [selectedServer, setSelectedServer] = useState(null);
  const [containers, setContainers] = useState([]);
  const [selectedContainer, setSelectedContainer] = useState(null);
  const [loadingContainers, setLoadingContainers] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [viewMode, setViewMode] = useState('detail'); // 'detail' | 'live' | 'prisma'

  // Load servers on startup
  useEffect(() => {
    loadServers();
  }, []);

  const loadServers = async () => {
    try {
      const data = await fetchServers();
      setServers(data);
    } catch (e) {
      console.error('Error loading servers:', e);
    }
  };

  // Load containers when selecting a server
  const loadContainers = useCallback(async (server) => {
    if (!server) return;
    setLoadingContainers(true);
    try {
      const data = await fetchContainers(server.id);
      setContainers(data);
    } catch (e) {
      console.error('Error loading containers:', e);
      setContainers([]);
    }
    setLoadingContainers(false);
  }, []);

  const handleSelectServer = (server) => {
    setSelectedServer(server);
    setSelectedContainer(null);
    setContainers([]);
    loadContainers(server);
  };

  const handleDeleteServer = async (serverId) => {
    try {
      await deleteServer(serverId);
      setServers((prev) => prev.filter((s) => s.id !== serverId));
      if (selectedServer?.id === serverId) {
        setSelectedServer(null);
        setContainers([]);
        setSelectedContainer(null);
      }
    } catch (e) {
      console.error('Error deleting server:', e);
    }
  };

  const handleServerAdded = (server) => {
    loadServers();
  };

  const handleSelectContainer = (container) => {
    setSelectedContainer(container);
    setViewMode('detail');
  };

  return (
    <div className="h-screen flex flex-col">
      {/* Top bar */}
      <header
        className="flex-shrink-0 border-b border-dark-800 bg-dark-900/80 backdrop-blur-sm px-4 py-3"
        style={isElectron ? { paddingLeft: '5rem', WebkitAppRegion: 'drag' } : {}}
      >
        <div className="flex items-center justify-between" style={isElectron ? { WebkitAppRegion: 'no-drag' } : {}}>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-blue-600/20 rounded-lg">
                <Terminal className="w-5 h-5 text-blue-400" />
              </div>
              <h1 className="text-lg font-bold text-gray-100">SSH Admin</h1>
            </div>
            <span className="text-xs text-gray-500 bg-dark-800 px-2 py-0.5 rounded-full">
              Docker Monitor
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Mode toggle */}
            <div className="flex items-center bg-dark-800 rounded-lg p-0.5">
              {selectedServer && (
                <>
                  <button
                    onClick={() => setViewMode('detail')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      viewMode === 'detail'
                        ? 'bg-dark-600 text-gray-200 shadow-sm'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    <Box className="w-3.5 h-3.5" />
                    Detail
                  </button>
                  <button
                    onClick={() => setViewMode('live')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      viewMode === 'live'
                        ? 'bg-green-600/20 text-green-400 shadow-sm'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    <Radio className="w-3.5 h-3.5" />
                    Live
                  </button>
                </>
              )}
              <button
                onClick={() => setViewMode('prisma')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  viewMode === 'prisma'
                    ? 'bg-purple-600/20 text-purple-400 shadow-sm'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                Prisma
              </button>
            </div>

            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Monitor className="w-4 h-4" />
              <span>{servers.length} server{servers.length !== 1 ? 's' : ''}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex gap-3 p-3 overflow-hidden">
        <ServerList
          servers={servers}
          selectedServer={selectedServer}
          onSelect={handleSelectServer}
          onDelete={handleDeleteServer}
          onAdd={() => setShowAddModal(true)}
        />

        {viewMode === 'prisma' ? (
          <PrismaView servers={servers} selectedServer={selectedServer} />
        ) : viewMode === 'detail' ? (
          <>
            <ContainerList
              server={selectedServer}
              containers={containers}
              loading={loadingContainers}
              selectedContainer={selectedContainer}
              onSelect={handleSelectContainer}
              onRefresh={() => loadContainers(selectedServer)}
            />
            <LogViewer
              server={selectedServer}
              container={selectedContainer}
            />
          </>
        ) : (
          <LiveView server={selectedServer} />
        )}
      </main>

      {/* Add server modal */}
      <AddServerModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onServerAdded={handleServerAdded}
      />
    </div>
  );
}
