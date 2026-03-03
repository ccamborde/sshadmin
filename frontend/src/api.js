// In packaged Electron mode, the frontend is served by the backend on the same port
// In dev mode, the Vite proxy redirects /api to the backend
const API_BASE = '/api';

export async function fetchServers() {
  const res = await fetch(`${API_BASE}/servers`);
  if (!res.ok) throw new Error('Error fetching servers');
  const data = await res.json();
  return data.servers;
}

export async function addServer(server) {
  const res = await fetch(`${API_BASE}/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(server),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Error adding server');
  }
  const data = await res.json();
  return data.server;
}

export async function deleteServer(serverId) {
  const res = await fetch(`${API_BASE}/servers/${serverId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Error deleting server');
  return true;
}

export async function testConnection(server) {
  const res = await fetch(`${API_BASE}/servers/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(server),
  });
  if (!res.ok) throw new Error('Error testing connection');
  return await res.json();
}

export async function fetchServerStats(serverId) {
  try {
    const res = await fetch(`${API_BASE}/servers/${serverId}/stats`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.stats;
  } catch {
    return null;
  }
}

export async function fetchContainers(serverId) {
  const res = await fetch(`${API_BASE}/servers/${serverId}/containers`);
  if (!res.ok) throw new Error('Error fetching containers');
  const data = await res.json();
  return data.containers;
}

export async function dockerAction(serverId, containerId, action) {
  const res = await fetch(`${API_BASE}/servers/${serverId}/containers/${containerId}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || `Error performing action "${action}"`);
  }
  return await res.json();
}

export async function dockerInspect(serverId, containerId) {
  const res = await fetch(`${API_BASE}/servers/${serverId}/containers/${containerId}/inspect`);
  if (!res.ok) throw new Error('Error inspecting container');
  const data = await res.json();
  return data.inspect;
}

export async function fetchLogs(serverId, containerId, tail = 200, since = null) {
  let url = `${API_BASE}/servers/${serverId}/containers/${containerId}/logs?tail=${tail}`;
  if (since) url += `&since=${since}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Error fetching logs');
  const data = await res.json();
  return data.logs;
}

export async function fetchAllLogs(serverId, tail = 30, since = null) {
  let url = `${API_BASE}/servers/${serverId}/logs/all?tail=${tail}`;
  if (since) url += `&since=${since}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Error fetching logs');
  const data = await res.json();
  return data.logs;
}

export function createLogWebSocket(serverId, containerId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/logs/${serverId}/${containerId}`;
  return new WebSocket(wsUrl);
}

export function createAllLogsWebSocket(serverId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/logs/${serverId}`;
  return new WebSocket(wsUrl);
}


// ═══════════════════════════════════════════════════════════
//  Prisma Studio
// ═══════════════════════════════════════════════════════════

export async function findPrismaSchemas(serverId) {
  const res = await fetch(`${API_BASE}/servers/${serverId}/prisma/find-schemas`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Error searching for schemas');
  }
  const data = await res.json();
  return data.schemas;
}

export async function fetchCachedSchemas(serverId) {
  const res = await fetch(`${API_BASE}/servers/${serverId}/prisma/cached-schemas`);
  if (!res.ok) return { schemas: [], scanning: false };
  return await res.json();
}

export async function rescanPrismaSchemas(serverId) {
  const res = await fetch(`${API_BASE}/servers/${serverId}/prisma/scan`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Error scanning');
  }
  return await res.json();
}

export async function findDatabaseUrls(serverId, schemaDir) {
  const res = await fetch(`${API_BASE}/servers/${serverId}/prisma/find-env`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema_dir: schemaDir }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Error searching for DATABASE_URL');
  }
  const data = await res.json();
  return data.urls;
}

export async function fetchPrismaProjects(serverId = null) {
  let url = `${API_BASE}/prisma/projects`;
  if (serverId) url += `?server_id=${String(serverId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Error fetching Prisma projects');
  const data = await res.json();
  return data.projects;
}

export async function addPrismaProject(project) {
  const res = await fetch(`${API_BASE}/prisma/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...project, server_id: String(project.server_id) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = err.detail;
    // FastAPI 422 returns detail as array of objects
    if (Array.isArray(detail)) {
      throw new Error(detail.map((d) => d.msg || JSON.stringify(d)).join('; '));
    }
    throw new Error(typeof detail === 'string' ? detail : 'Error creating project');
  }
  const data = await res.json();
  return data.project;
}

export async function startPrismaProject(projectId) {
  const res = await fetch(`${API_BASE}/prisma/projects/${projectId}/start`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Error starting project');
  }
  return await res.json();
}

export async function stopPrismaProject(projectId) {
  const res = await fetch(`${API_BASE}/prisma/projects/${projectId}/stop`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Error stopping project');
  }
  return await res.json();
}

export async function getPrismaProjectStatus(projectId) {
  const res = await fetch(`${API_BASE}/prisma/projects/${projectId}/status`);
  if (!res.ok) return { status: 'unknown' };
  return await res.json();
}

export async function refreshPrismaSchema(projectId) {
  const res = await fetch(`${API_BASE}/prisma/projects/${projectId}/refresh`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Error refreshing schema');
  }
  return await res.json();
}

export async function deletePrismaProject(projectId) {
  const res = await fetch(`${API_BASE}/prisma/projects/${projectId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Error deleting project');
  }
  return await res.json();
}
