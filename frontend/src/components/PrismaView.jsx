import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Database, Play, Square, RefreshCw, Trash2, Plus,
  ExternalLink, Loader2, AlertCircle, CheckCircle2,
  Server, FolderOpen, Globe, ChevronRight, Box, Zap,
} from 'lucide-react';
import {
  fetchPrismaProjects, startPrismaProject, stopPrismaProject,
  deletePrismaProject, refreshPrismaSchema,
  fetchCachedSchemas, rescanPrismaSchemas, addPrismaProject,
} from '../api';

const statusConfig = {
  running:  { label: 'Running',   color: 'text-green-400', bg: 'bg-green-400', pulse: true },
  partial:  { label: 'Partial',   color: 'text-yellow-400', bg: 'bg-yellow-400', pulse: true },
  stopped:  { label: 'Stopped',   color: 'text-gray-500', bg: 'bg-gray-500', pulse: false },
  starting: { label: 'Starting…', color: 'text-blue-400', bg: 'bg-blue-400', pulse: true },
  stopping: { label: 'Stopping…', color: 'text-orange-400', bg: 'bg-orange-400', pulse: true },
  adding:   { label: 'Adding…',   color: 'text-purple-400', bg: 'bg-purple-400', pulse: true },
  error:    { label: 'Error',     color: 'text-red-400', bg: 'bg-red-400', pulse: false },
  unknown:  { label: 'Unknown',   color: 'text-gray-500', bg: 'bg-gray-500', pulse: false },
};

function StatusBadge({ status }) {
  const cfg = statusConfig[status] || statusConfig.unknown;
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-2 h-2 rounded-full ${cfg.bg} ${cfg.pulse ? 'animate-pulse-dot' : ''}`} />
      <span className={`text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
    </div>
  );
}

function MaskUrl(url) {
  try {
    return url.replace(/:([^@/]+)@/, ':•••@');
  } catch {
    return url;
  }
}

export default function PrismaView({ servers, selectedServer }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedProject, setSelectedProject] = useState(null);
  const [actionLoading, setActionLoading] = useState({});
  const [actionError, setActionError] = useState({});
  const pollRef = useRef(null);

  // Cached schemas
  const [cachedSchemas, setCachedSchemas] = useState([]);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [scanning, setScanning] = useState(false);

  // For schemas without DATABASE_URL — inline input
  const [dbUrlInput, setDbUrlInput] = useState({});   // key -> url string
  const [addingSchema, setAddingSchema] = useState({}); // key -> boolean

  const isRemoteServer = selectedServer && selectedServer.id !== 'local';
  const serverId = isRemoteServer ? String(selectedServer.id) : null;

  // ── Load projects ──────────────────────────────
  const loadProjects = useCallback(async () => {
    try {
      const data = await fetchPrismaProjects(serverId);
      setProjects(data);
    } catch (e) {
      console.error('Error loading Prisma projects:', e);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  // ── Load cached schemas ──────────────────────────
  const loadCachedSchemas = useCallback(async () => {
    if (!serverId) { setCachedSchemas([]); return; }
    setLoadingSchemas(true);
    try {
      const data = await fetchCachedSchemas(serverId);
      setCachedSchemas(data.schemas || []);
      setScanning(data.scanning || false);
    } catch (e) {
      console.error('Error loading cached schemas:', e);
    } finally {
      setLoadingSchemas(false);
    }
  }, [serverId]);

  useEffect(() => {
    setLoading(true);
    setSelectedProject(null);
    loadProjects();
    loadCachedSchemas();
    pollRef.current = setInterval(loadProjects, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadProjects, loadCachedSchemas]);

  // ── Re-scan ──────────────────────────────────────
  const handleRescan = async () => {
    if (!serverId) return;
    setScanning(true);
    try {
      await rescanPrismaSchemas(serverId);
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const data = await fetchCachedSchemas(serverId);
          setCachedSchemas(data.schemas || []);
          if (!data.scanning || attempts > 30) {
            setScanning(false);
            clearInterval(poll);
          }
        } catch {
          clearInterval(poll);
          setScanning(false);
        }
      }, 2000);
    } catch (e) {
      console.error('Scan error:', e);
      setScanning(false);
    }
  };

  // ── Deduplicate cached schemas ──────────────────
  const deduplicatedCached = (() => {
    const seen = new Map();
    for (const s of cachedSchemas) {
      const key = `${s.database_url || ''}||${s.schema_path}`;
      if (!seen.has(key)) {
        seen.set(key, { ...s, all_containers: [s.container_name] });
      } else {
        seen.get(key).all_containers.push(s.container_name);
      }
    }
    return Array.from(seen.values());
  })();

  // Filter out schemas that already have a project
  const availableSchemas = deduplicatedCached.filter((cached) => {
    const remotePath = `container:${cached.container_name}:${cached.schema_path}`;
    return !projects.some((p) => p.remote_schema_path === remotePath);
  });

  // ── Auto-add a detected schema as project + start ──
  const handleQuickAdd = async (cached, manualDbUrl = null) => {
    const key = `${cached.container_name}:${cached.schema_path}`;
    const dbUrl = manualDbUrl || cached.database_url;
    if (!dbUrl || !dbUrl.trim()) return;

    setAddingSchema((prev) => ({ ...prev, [key]: true }));
    setActionError((prev) => ({ ...prev, [key]: null }));
    try {
      // 1) Create the project
      const project = await addPrismaProject({
        server_id: serverId,
        name: cached.container_name,
        remote_schema_path: `container:${cached.container_name}:${cached.schema_path}`,
        database_url: dbUrl.trim(),
      });

      // 2) Start it immediately
      try {
        await startPrismaProject(project.id);
      } catch (e) {
        // Project created but failed to start — still reload
        setActionError((prev) => ({ ...prev, [project.id]: e.message }));
      }

      await loadProjects();
      setSelectedProject(project);
      setDbUrlInput((prev) => { const n = { ...prev }; delete n[key]; return n; });
    } catch (e) {
      setActionError((prev) => ({ ...prev, [key]: typeof e === 'object' && e.message ? e.message : String(e) }));
    } finally {
      setAddingSchema((prev) => ({ ...prev, [key]: false }));
    }
  };

  // ── Project actions ────────────────────────────
  const handleStart = async (project) => {
    setActionLoading((prev) => ({ ...prev, [project.id]: 'starting' }));
    setActionError((prev) => ({ ...prev, [project.id]: null }));
    try {
      await startPrismaProject(project.id);
      await loadProjects();
    } catch (e) {
      setActionError((prev) => ({ ...prev, [project.id]: e.message }));
    } finally {
      setActionLoading((prev) => ({ ...prev, [project.id]: null }));
    }
  };

  const handleStop = async (project) => {
    setActionLoading((prev) => ({ ...prev, [project.id]: 'stopping' }));
    setActionError((prev) => ({ ...prev, [project.id]: null }));
    try {
      await stopPrismaProject(project.id);
      await loadProjects();
    } catch (e) {
      setActionError((prev) => ({ ...prev, [project.id]: e.message }));
    } finally {
      setActionLoading((prev) => ({ ...prev, [project.id]: null }));
    }
  };

  const handleDelete = async (project) => {
    if (!confirm(`Delete Prisma project "${project.name}"?`)) return;
    setActionLoading((prev) => ({ ...prev, [project.id]: 'deleting' }));
    try {
      await deletePrismaProject(project.id);
      if (selectedProject?.id === project.id) setSelectedProject(null);
      await loadProjects();
    } catch (e) {
      setActionError((prev) => ({ ...prev, [project.id]: e.message }));
    } finally {
      setActionLoading((prev) => ({ ...prev, [project.id]: null }));
    }
  };

  const activeProject = selectedProject
    ? projects.find((p) => p.id === selectedProject.id)
    : null;
  const studioReady = activeProject?.status === 'running';

  return (
    <div className="flex-1 flex gap-3 overflow-hidden">
      {/* ── Left column ───────────── */}
      <div className="w-96 flex-shrink-0 card flex flex-col h-full">
        <div className="p-4 border-b border-dark-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-purple-400" />
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                Prisma Studio
              </h2>
            </div>
            {isRemoteServer && (
              <button
                onClick={handleRescan}
                disabled={scanning}
                className="p-1.5 hover:bg-dark-800 rounded-lg transition-colors group"
                title="Scan containers for Prisma schemas"
              >
                <RefreshCw className={`w-4 h-4 text-gray-500 group-hover:text-purple-400 transition-colors ${scanning ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>
          {selectedServer && (
            <p className="text-xs text-gray-500 mt-1">{selectedServer.name}</p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">

          {/* No server selected */}
          {!selectedServer && (
            <div className="text-center py-12 px-4">
              <Server className="w-12 h-12 text-dark-600 mx-auto mb-3" />
              <p className="text-sm text-gray-500">Select a server</p>
              <p className="text-xs text-gray-600 mt-1">
                to view Prisma projects and detected schemas
              </p>
            </div>
          )}

          {/* Localhost */}
          {selectedServer && selectedServer.id === 'local' && (
            <div className="text-center py-12 px-4">
              <Database className="w-12 h-12 text-dark-600 mx-auto mb-3" />
              <p className="text-sm text-gray-500">Not available for localhost</p>
              <p className="text-xs text-gray-600 mt-1">
                Select a remote server to use Prisma Studio
              </p>
            </div>
          )}

          {/* Remote server */}
          {isRemoteServer && (
            <>
              {/* Loading spinner */}
              {loading && projects.length === 0 && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 text-gray-500 animate-spin" />
                </div>
              )}

              {/* ── Existing projects ────────────────── */}
              {projects.map((project) => {
                const isSelected = selectedProject?.id === project.id;
                const actionState = actionLoading[project.id];
                const error = actionError[project.id];
                const displayStatus = actionState || project.status;

                return (
                  <div
                    key={project.id}
                    onClick={() => setSelectedProject(project)}
                    className={`group p-3 rounded-lg cursor-pointer transition-all duration-150 ${
                      isSelected
                        ? 'bg-purple-600/15 border border-purple-500/30'
                        : 'hover:bg-dark-800 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <Database className={`w-3.5 h-3.5 flex-shrink-0 ${isSelected ? 'text-purple-400' : 'text-gray-600'}`} />
                        <p className={`text-sm font-semibold truncate ${isSelected ? 'text-purple-300' : 'text-gray-300'}`}>
                          {project.name}
                        </p>
                      </div>
                      <StatusBadge status={displayStatus} />
                    </div>

                    <div className="ml-5 text-[10px] text-gray-600 font-mono truncate">
                      {MaskUrl(project.database_url)}
                    </div>

                    {/* Error */}
                    {error && (
                      <div className="ml-5 mt-1.5 flex items-start gap-1.5 text-xs text-red-400 bg-red-950/30 p-2 rounded-md">
                        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                        <span className="break-all">{error}</span>
                      </div>
                    )}

                    {/* Action buttons */}
                    <div className="ml-5 mt-1.5 flex items-center gap-1.5">
                      {project.status === 'stopped' || project.status === 'partial' ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleStart(project); }}
                          disabled={!!actionState}
                          className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-green-600/20 hover:bg-green-600/30 text-green-400 rounded-md transition-colors disabled:opacity-40"
                        >
                          {actionState === 'starting' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                          Start
                        </button>
                      ) : project.status === 'running' ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleStop(project); }}
                          disabled={!!actionState}
                          className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-md transition-colors disabled:opacity-40"
                        >
                          {actionState === 'stopping' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                          Stop
                        </button>
                      ) : null}

                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(project); }}
                        disabled={!!actionState}
                        className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-dark-700 hover:bg-red-600/20 text-gray-500 hover:text-red-400 rounded-md transition-colors disabled:opacity-40"
                        title="Delete project"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* ── Detected schemas (not yet added) ──── */}
              {availableSchemas.length > 0 && (
                <>
                  {projects.length > 0 && (
                    <div className="border-t border-dark-700 my-2" />
                  )}
                  <div className="flex items-center gap-2 px-1 py-1">
                    <Zap className="w-3.5 h-3.5 text-yellow-400" />
                    <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Detected schemas
                    </span>
                    {(loadingSchemas || scanning) && (
                      <Loader2 className="w-3 h-3 text-gray-500 animate-spin" />
                    )}
                  </div>

                  {availableSchemas.map((cached) => {
                    const key = `${cached.container_name}:${cached.schema_path}`;
                    const isAdding = addingSchema[key];
                    const error = actionError[key];
                    const hasDbUrl = !!cached.database_url;
                    const showDbInput = !hasDbUrl;

                    return (
                      <div
                        key={key}
                        className="p-2.5 rounded-lg border border-transparent hover:border-purple-500/20 hover:bg-dark-800 transition-all duration-150"
                      >
                        <div className="flex items-center gap-2.5">
                          <div className="p-1 bg-dark-700 rounded-md">
                            <Box className="w-3.5 h-3.5 text-blue-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-medium text-gray-300 truncate">
                                {cached.container_name}
                              </span>
                              {hasDbUrl && (
                                <CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" title="DATABASE_URL found" />
                              )}
                            </div>
                            <p className="text-[10px] text-gray-600 font-mono truncate">
                              {cached.schema_path}
                            </p>
                          </div>

                          {/* Quick-add button (when DATABASE_URL is available) */}
                          {hasDbUrl && (
                            <button
                              onClick={() => handleQuickAdd(cached)}
                              disabled={isAdding}
                              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 rounded-md transition-colors disabled:opacity-40 flex-shrink-0"
                              title="Add & start"
                            >
                              {isAdding ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Plus className="w-3 h-3" />
                              )}
                              {isAdding ? 'Adding…' : 'Add'}
                            </button>
                          )}
                        </div>

                        {/* Inline DATABASE_URL input when not found in cache */}
                        {showDbInput && (
                          <div className="mt-2 ml-7">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                value={dbUrlInput[key] || ''}
                                onChange={(e) => setDbUrlInput((prev) => ({ ...prev, [key]: e.target.value }))}
                                placeholder="postgresql://user:pass@host:5432/db"
                                className="input flex-1 text-[11px] py-1 px-2 font-mono"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && dbUrlInput[key]?.trim()) {
                                    handleQuickAdd(cached, dbUrlInput[key]);
                                  }
                                }}
                              />
                              <button
                                onClick={() => handleQuickAdd(cached, dbUrlInput[key])}
                                disabled={isAdding || !dbUrlInput[key]?.trim()}
                                className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 rounded-md transition-colors disabled:opacity-40 flex-shrink-0"
                              >
                                {isAdding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                              </button>
                            </div>
                            <p className="text-[9px] text-gray-600 mt-0.5">
                              No DATABASE_URL detected — enter it manually
                            </p>
                          </div>
                        )}

                        {/* Error for this schema */}
                        {error && (
                          <div className="mt-1.5 ml-7 flex items-start gap-1.5 text-xs text-red-400 bg-red-950/30 p-2 rounded-md">
                            <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                            <span className="break-all text-[10px]">{error}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}

              {/* Empty state */}
              {!loading && projects.length === 0 && availableSchemas.length === 0 && !scanning && (
                <div className="text-center py-12 px-4">
                  <Database className="w-12 h-12 text-dark-600 mx-auto mb-3" />
                  <p className="text-sm text-gray-500">No Prisma schemas detected</p>
                  <p className="text-xs text-gray-600 mt-1">
                    Click the refresh button to scan containers
                  </p>
                </div>
              )}

              {/* Scanning state */}
              {scanning && projects.length === 0 && availableSchemas.length === 0 && (
                <div className="text-center py-12 px-4">
                  <Loader2 className="w-10 h-10 text-purple-400 mx-auto mb-3 animate-spin" />
                  <p className="text-sm text-gray-400">Scanning containers…</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Main area: iframe ───────── */}
      <div className="flex-1 card flex flex-col h-full overflow-hidden">
        {!activeProject && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <Database className="w-16 h-16 text-dark-700 mx-auto mb-4" />
              <p className="text-gray-500 text-lg">Prisma Studio</p>
              <p className="text-gray-600 text-sm mt-1">
                Select a project to browse the database
              </p>
            </div>
          </div>
        )}

        {activeProject && !studioReady && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              {actionLoading[activeProject.id] === 'starting' ? (
                <Loader2 className="w-12 h-12 text-blue-400 mx-auto mb-4 animate-spin" />
              ) : (
                <Database className="w-12 h-12 text-gray-600 mx-auto mb-4" />
              )}
              <p className="text-gray-400 text-lg font-medium">{activeProject.name}</p>
              <p className="text-gray-600 text-sm mt-1 mb-4">
                {actionLoading[activeProject.id] === 'starting'
                  ? 'Starting… SSH tunnel + Prisma Studio are being set up.'
                  : activeProject.status === 'stopped'
                  ? 'Project is stopped. Start it to access Prisma Studio.'
                  : activeProject.status === 'partial'
                  ? 'Prisma Studio has crashed. Restart the project.'
                  : 'Status: ' + activeProject.status}
              </p>
              {(activeProject.status === 'stopped' || activeProject.status === 'partial') && !actionLoading[activeProject.id] && (
                <button
                  onClick={() => handleStart(activeProject)}
                  disabled={!!actionLoading[activeProject.id]}
                  className="btn-primary flex items-center gap-2 mx-auto"
                >
                  <Play className="w-4 h-4" />
                  {activeProject.status === 'partial' ? 'Restart' : 'Start project'}
                </button>
              )}
              {actionError[activeProject.id] && (
                <div className="mt-4 flex items-start gap-2 text-sm text-red-400 bg-red-950/30 p-3 rounded-lg max-w-md mx-auto text-left">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span className="break-all">{actionError[activeProject.id]}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {activeProject && studioReady && (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b border-dark-700 bg-dark-900/50">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse-dot" />
                <span className="text-sm font-medium text-gray-300">
                  {activeProject.name}
                </span>
                <span className="text-xs text-gray-600">
                  — {activeProject.studio_url}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={activeProject.studio_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 px-2 py-1 text-xs text-purple-400 hover:text-purple-300 hover:bg-purple-600/10 rounded transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  New tab
                </a>
                <button
                  onClick={() => handleStop(activeProject)}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-600/10 rounded transition-colors"
                >
                  <Square className="w-3.5 h-3.5" />
                  Stop
                </button>
              </div>
            </div>
            <div className="flex-1">
              <iframe
                src={activeProject.studio_url}
                className="w-full h-full border-0"
                title={`Prisma Studio - ${activeProject.name}`}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
