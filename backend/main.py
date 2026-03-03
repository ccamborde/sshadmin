from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional
import asyncio
import json
import re
import os
import sys

from database import (
    init_db, add_server, get_servers, get_server, delete_server,
    server_exists, upsert_server,
    init_prisma_db, add_prisma_project, get_prisma_projects,
    get_prisma_project, delete_prisma_project, get_used_prisma_ports,
    init_prisma_cache_db, upsert_cached_schema, get_cached_schemas,
    clear_cached_schemas,
)
from ssh_manager import (
    test_connection, list_containers, get_container_logs,
    stream_container_logs, docker_action, docker_inspect,
    get_all_containers_logs, stream_all_containers_logs,
    parse_docker_logs, get_server_stats,
)
from local_docker import (
    LOCALHOST_SERVER, is_docker_available,
    local_list_containers, local_get_container_logs,
    local_stream_container_logs, local_docker_action,
    local_docker_inspect, local_get_all_containers_logs,
    local_stream_all_containers_logs, local_test_connection,
    local_get_stats,
)
from prisma_manager import (
    find_schema_files, find_database_urls, find_free_port,
    scan_containers_for_schemas,
    start_project as prisma_start_project,
    stop_project as prisma_stop_project,
    project_status as prisma_project_status,
    refresh_schema as prisma_refresh_schema,
    cleanup_all as prisma_cleanup_all,
    cleanup_workspace as prisma_cleanup_workspace,
)

# ── Localhost state ───────────────────────────────────────
_docker_local_available = False
_schema_scan_in_progress: set[str] = set()  # server_ids currently being scanned


# ── Load .env file ───────────────────────────────────────

def _find_env_file() -> str | None:
    """Find the .env file in multiple locations (dev, compiled, Docker)."""
    candidates = [
        # 1) SSHADMIN_DB_DIR (Docker volume)
        os.path.join(os.environ.get("SSHADMIN_DB_DIR", ""), ".env")
            if os.environ.get("SSHADMIN_DB_DIR") else None,
        # 2) Next to the backend (dev mode)
        os.path.join(os.path.dirname(__file__), "..", ".env"),
        # 3) User config directory
        os.path.expanduser("~/.sshadmin/.env"),
        # 4) Next to the executable (PyInstaller)
        os.path.join(os.path.dirname(sys.executable), ".env")
            if getattr(sys, "frozen", False) else None,
        # 5) Electron Resources directory
        os.path.join(os.environ.get("SSHADMIN_STATIC_DIR", ""), "..", ".env")
            if os.environ.get("SSHADMIN_STATIC_DIR") else None,
        # 6) CWD
        os.path.join(os.getcwd(), ".env"),
    ]
    for p in candidates:
        if p and os.path.isfile(os.path.abspath(p)):
            return os.path.abspath(p)
    return None


def _parse_env_file(path: str) -> dict[str, str]:
    """Parse a .env file into a dict (simple KEY=VALUE format)."""
    env = {}
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


def _parse_server_entry(value: str) -> dict | None:
    """
    Parse a server entry: name|user@host:port|key_path
    Returns dict with name, host, user, port, key_path or None on error.
    """
    parts = value.split("|")
    if len(parts) < 2:
        return None

    name = parts[0].strip()
    user_host = parts[1].strip()
    key_path = parts[2].strip() if len(parts) > 2 else ""

    if "@" not in user_host:
        return None

    user, _, host_port = user_host.partition("@")
    if ":" in host_port:
        host, _, port_str = host_port.partition(":")
        try:
            port = int(port_str)
        except ValueError:
            port = 22
    else:
        host = host_port
        port = 22

    if not name or not host or not user:
        return None

    return {
        "name": name,
        "host": host,
        "user": user,
        "port": port,
        "key_path": key_path,
    }


async def _load_servers_from_env():
    """Load servers from .env file and register them in the database."""
    env_path = _find_env_file()
    if not env_path:
        return

    print(f"[config] Loading servers from {env_path}")
    env = _parse_env_file(env_path)

    # Collect SSHADMIN_SERVER_* entries sorted by number
    server_entries = []
    for key, value in env.items():
        if key.startswith("SSHADMIN_SERVER_"):
            server_entries.append((key, value))
    server_entries.sort()

    added = 0
    updated = 0
    unchanged = 0
    for key, value in server_entries:
        parsed = _parse_server_entry(value)
        if not parsed:
            print(f"[config] ⚠ Invalid format for {key}: {value}")
            continue

        try:
            server, action = await upsert_server(
                name=parsed["name"],
                host=parsed["host"],
                user=parsed["user"],
                port=parsed["port"],
                key_path=parsed["key_path"],
            )
            if action == "added":
                added += 1
                print(f"[config] ✓ Added server: {parsed['name']} ({parsed['user']}@{parsed['host']}:{parsed['port']})")
            elif action == "updated":
                updated += 1
                print(f"[config] ✓ Updated server: {parsed['name']} ({parsed['user']}@{parsed['host']}:{parsed['port']})")
            else:
                unchanged += 1
        except Exception as e:
            print(f"[config] ✗ Failed to add {parsed['name']}: {e}")

    total = added + updated + unchanged
    if total:
        print(f"[config] Servers from .env: {total} total — {added} added, {updated} updated, {unchanged} unchanged")


@asynccontextmanager
async def lifespan(app):
    global _docker_local_available
    await init_db()
    await init_prisma_db()
    await init_prisma_cache_db()
    _docker_local_available = is_docker_available()
    await _load_servers_from_env()
    yield
    # Cleanup: stop all Prisma tunnels/studios
    prisma_cleanup_all()


app = FastAPI(title="SSH Admin - Docker Monitor", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ServerCreate(BaseModel):
    name: str
    host: str
    user: str
    port: int = 22
    key_path: str = ""


class DockerActionRequest(BaseModel):
    action: str


class PrismaProjectCreate(BaseModel):
    server_id: str
    name: str
    remote_schema_path: str
    database_url: str


class FindEnvRequest(BaseModel):
    schema_dir: str


# ── Helper: resolve server by ID (DB or local) ──────────

def _is_local(server_id: str) -> bool:
    return str(server_id) == "local"


async def _resolve_server(server_id: str) -> dict:
    if _is_local(server_id):
        if not _docker_local_available:
            raise HTTPException(status_code=404, detail="Local Docker not available")
        return LOCALHOST_SERVER
    try:
        sid = int(server_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid server ID")
    server = await get_server(sid)
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    return server


# ── Servers ──────────────────────────────────────────────

@app.get("/api/servers")
async def api_get_servers():
    servers = await get_servers()
    # Add localhost at the top if Docker is available
    if _docker_local_available:
        servers = [LOCALHOST_SERVER] + servers
    return {"servers": servers}


@app.post("/api/servers")
async def api_add_server(server: ServerCreate):
    key_path = server.key_path or None
    result = test_connection(server.host, server.user, server.port, key_path)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=f"SSH connection failed: {result['message']}")
    try:
        new_server = await add_server(server.name, server.host, server.user, server.port, server.key_path)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"server": new_server}


@app.delete("/api/servers/{server_id}")
async def api_delete_server(server_id: str):
    if _is_local(server_id):
        raise HTTPException(status_code=400, detail="Cannot delete local server")
    try:
        sid = int(server_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid server ID")
    deleted = await delete_server(sid)
    if not deleted:
        raise HTTPException(status_code=404, detail="Server not found")
    return {"success": True}


@app.post("/api/servers/test")
async def api_test_connection(server: ServerCreate):
    key_path = server.key_path or None
    result = test_connection(server.host, server.user, server.port, key_path)
    return result


# ── System stats ─────────────────────────────────────────

@app.get("/api/servers/{server_id}/stats")
async def api_server_stats(server_id: str):
    server = await _resolve_server(server_id)
    try:
        if server.get("is_local"):
            stats = local_get_stats()
        else:
            key_path = server.get("key_path") or None
            stats = get_server_stats(
                server["host"], server["user"], server["port"], key_path
            )
        return {"stats": stats}
    except Exception as e:
        return {"stats": {"error": str(e)}}


# ── Containers Docker ─────────────────────────────────────

@app.get("/api/servers/{server_id}/containers")
async def api_list_containers(server_id: str):
    server = await _resolve_server(server_id)
    try:
        if server.get("is_local"):
            containers = local_list_containers()
        else:
            key_path = server.get("key_path") or None
            containers = list_containers(server["host"], server["user"], server["port"], key_path)

            # Trigger a background Prisma scan (if not already in progress)
            if str(server_id) not in _schema_scan_in_progress:
                container_names = [c["name"] for c in containers if c.get("state") == "running"]
                if container_names:
                    asyncio.create_task(
                        _background_schema_scan(str(server_id), server, container_names)
                    )

        return {"containers": containers}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


async def _background_schema_scan(server_id: str, server: dict, container_names: list[str]):
    """Background scan of containers for schema.prisma files."""
    if server_id in _schema_scan_in_progress:
        return
    _schema_scan_in_progress.add(server_id)
    try:
        key_path = server.get("key_path") or None
        found = await asyncio.to_thread(
            scan_containers_for_schemas,
            server["host"], server["user"], server["port"], key_path,
            container_names,
        )
        # Save each result in cache
        for item in found:
            await upsert_cached_schema(
                server_id=server_id,
                container_name=item["container_name"],
                schema_path=item["schema_path"],
                database_url=item.get("database_url", ""),
            )
    except Exception as e:
        print(f"[prisma-scan] Background scan error for server {server_id}: {e}")
    finally:
        _schema_scan_in_progress.discard(server_id)


# ── Docker actions ────────────────────────────────────────

@app.post("/api/servers/{server_id}/containers/{container_id}/action")
async def api_docker_action(server_id: str, container_id: str, req: DockerActionRequest):
    server = await _resolve_server(server_id)
    try:
        if server.get("is_local"):
            result = local_docker_action(container_id, req.action)
        else:
            key_path = server.get("key_path") or None
            result = docker_action(
                server["host"], server["user"], container_id,
                req.action, server["port"], key_path,
            )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/servers/{server_id}/containers/{container_id}/inspect")
async def api_docker_inspect(server_id: str, container_id: str):
    server = await _resolve_server(server_id)
    try:
        if server.get("is_local"):
            info = local_docker_inspect(container_id)
        else:
            key_path = server.get("key_path") or None
            info = docker_inspect(
                server["host"], server["user"], container_id,
                server["port"], key_path,
            )
        return {"inspect": info}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Docker logs ───────────────────────────────────────────

@app.get("/api/servers/{server_id}/containers/{container_id}/logs")
async def api_get_logs(server_id: str, container_id: str, tail: int = 200, since: Optional[str] = None):
    server = await _resolve_server(server_id)
    try:
        if server.get("is_local"):
            logs = local_get_container_logs(container_id, tail, since)
        else:
            key_path = server.get("key_path") or None
            logs = get_container_logs(
                server["host"], server["user"], container_id,
                server["port"], key_path, tail, since
            )
        return {"logs": logs, "container_id": container_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Live logs (all containers) ────────────────────────────

@app.get("/api/servers/{server_id}/logs/all")
async def api_get_all_logs(server_id: str, tail: int = 30, since: Optional[str] = None):
    server = await _resolve_server(server_id)
    try:
        if server.get("is_local"):
            logs = local_get_all_containers_logs(tail, since)
        else:
            key_path = server.get("key_path") or None
            logs = get_all_containers_logs(
                server["host"], server["user"],
                server["port"], key_path, tail, since
            )
        return {"logs": logs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── WebSocket helpers ─────────────────────────────────────

_ws_log_patterns = {
    "container": re.compile(r"^\[([^\]]+)\]\s*(.*)"),
    "timestamp": re.compile(r"^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(.*)"),
    "levels": {
        "error": re.compile(r"\b(ERROR|ERR|FATAL|CRITICAL|PANIC)\b", re.IGNORECASE),
        "warn": re.compile(r"\b(WARN|WARNING)\b", re.IGNORECASE),
        "info": re.compile(r"\b(INFO|NOTICE)\b", re.IGNORECASE),
        "debug": re.compile(r"\b(DEBUG|TRACE)\b", re.IGNORECASE),
    },
}


def _parse_ws_line(line: str, multi_container: bool = False) -> dict:
    """Parse a log line for WebSocket dispatch."""
    container_name = None
    rest = line

    if multi_container:
        cm = _ws_log_patterns["container"].match(line)
        if cm:
            container_name = cm.group(1)
            rest = cm.group(2)

    timestamp = None
    message = rest
    ts_match = _ws_log_patterns["timestamp"].match(rest)
    if ts_match:
        timestamp = ts_match.group(1)
        message = ts_match.group(2)

    level = "info"
    for lvl, pattern in _ws_log_patterns["levels"].items():
        if pattern.search(message):
            level = lvl
            break

    entry = {
        "timestamp": timestamp,
        "level": level,
        "message": message,
        "raw": line,
    }
    if multi_container:
        entry["container_name"] = container_name
    return entry


# ── WebSocket: single container logs ─────────────────────

@app.websocket("/ws/logs/{server_id}/{container_id}")
async def ws_stream_logs(websocket: WebSocket, server_id: str, container_id: str):
    await websocket.accept()

    try:
        server = await _resolve_server(server_id)
    except HTTPException:
        await websocket.send_json({"error": "Server not found"})
        await websocket.close()
        return

    try:
        if server.get("is_local"):
            gen = local_stream_container_logs(container_id, tail=50)
        else:
            key_path = server.get("key_path") or None
            gen = stream_container_logs(
                server["host"], server["user"], container_id,
                server["port"], key_path, tail=50
            )

        for line in gen:
            parsed = parse_docker_logs(line)
            if parsed:
                await websocket.send_json({"log": parsed[0]})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"error": str(e)})
        except Exception:
            pass


# ── WebSocket: all containers logs ────────────────────────

@app.websocket("/ws/logs/{server_id}")
async def ws_stream_all_logs(websocket: WebSocket, server_id: str):
    await websocket.accept()

    try:
        server = await _resolve_server(server_id)
    except HTTPException:
        await websocket.send_json({"error": "Server not found"})
        await websocket.close()
        return

    try:
        if server.get("is_local"):
            gen = local_stream_all_containers_logs(tail=5)
        else:
            key_path = server.get("key_path") or None
            gen = stream_all_containers_logs(
                server["host"], server["user"],
                server["port"], key_path, tail=5
            )

        for line in gen:
            entry = _parse_ws_line(line, multi_container=True)
            await websocket.send_json({"log": entry})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"error": str(e)})
        except Exception:
            pass


# ── Prisma Studio ─────────────────────────────────────────────

@app.get("/api/servers/{server_id}/prisma/find-schemas")
async def api_find_schemas(server_id: str):
    """Search for schema.prisma files on a remote server."""
    server = await _resolve_server(server_id)
    if server.get("is_local"):
        raise HTTPException(
            status_code=400,
            detail="Prisma search is not available for localhost",
        )
    try:
        key_path = server.get("key_path") or None
        schemas = await asyncio.to_thread(
            find_schema_files,
            server["host"], server["user"], server["port"], key_path,
        )
        return {"schemas": schemas}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/servers/{server_id}/prisma/cached-schemas")
async def api_cached_schemas(server_id: str):
    """Return automatically discovered Prisma schemas (cache)."""
    schemas = await get_cached_schemas(str(server_id))
    scanning = str(server_id) in _schema_scan_in_progress
    return {"schemas": schemas, "scanning": scanning}


@app.post("/api/servers/{server_id}/prisma/scan")
async def api_rescan_schemas(server_id: str):
    """Force a re-scan of containers to find Prisma schemas."""
    server = await _resolve_server(server_id)
    if server.get("is_local"):
        raise HTTPException(status_code=400, detail="Not available for localhost")

    if str(server_id) in _schema_scan_in_progress:
        return {"status": "already_scanning"}

    # List running containers
    key_path = server.get("key_path") or None
    try:
        containers = await asyncio.to_thread(
            list_containers,
            server["host"], server["user"], server["port"], key_path,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    container_names = [c["name"] for c in containers if c.get("state") == "running"]
    if not container_names:
        return {"status": "no_containers"}

    # Clear existing cache and restart the scan
    await clear_cached_schemas(str(server_id))
    asyncio.create_task(
        _background_schema_scan(str(server_id), server, container_names)
    )
    return {"status": "scanning", "containers": len(container_names)}


@app.post("/api/servers/{server_id}/prisma/find-env")
async def api_find_env(server_id: str, req: FindEnvRequest):
    """Search for DATABASE_URL in .env files near a schema."""
    server = await _resolve_server(server_id)
    if server.get("is_local"):
        raise HTTPException(status_code=400, detail="Not available for localhost")
    try:
        key_path = server.get("key_path") or None
        urls = await asyncio.to_thread(
            find_database_urls,
            server["host"], server["user"], server["port"], key_path,
            req.schema_dir,
        )
        return {"urls": urls}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/prisma/projects")
async def api_list_prisma_projects(server_id: Optional[str] = None):
    """List Prisma projects (optionally filtered by server)."""
    projects = await get_prisma_projects(server_id)

    # Enrich with real-time status and server info
    enriched = []
    for p in projects:
        p["status"] = prisma_project_status(p["id"])
        p["studio_url"] = f"http://127.0.0.1:{p['studio_port']}"
        # Add server name
        try:
            srv = await _resolve_server(p["server_id"])
            p["server_name"] = srv.get("name", p["server_id"])
        except Exception:
            p["server_name"] = p["server_id"]
        enriched.append(p)

    return {"projects": enriched}


@app.post("/api/prisma/projects")
async def api_add_prisma_project(req: PrismaProjectCreate):
    """Create a new Prisma project."""
    # Verify the server exists
    server = await _resolve_server(req.server_id)
    if server.get("is_local"):
        raise HTTPException(status_code=400, detail="Not supported for localhost")

    # Allocate ports
    used_ports = await get_used_prisma_ports()
    try:
        tunnel_port = find_free_port(15432, 15600, used_ports)
        used_ports.add(tunnel_port)
        studio_port = find_free_port(5555, 5655, used_ports)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Save to database
    project = await add_prisma_project(
        server_id=req.server_id,
        name=req.name,
        remote_schema_path=req.remote_schema_path,
        database_url=req.database_url,
        tunnel_port=tunnel_port,
        studio_port=studio_port,
    )
    project["status"] = "stopped"
    project["studio_url"] = f"http://127.0.0.1:{studio_port}"
    project["server_name"] = server.get("name", req.server_id)

    return {"project": project}


@app.post("/api/prisma/projects/{project_id}/start")
async def api_start_prisma(project_id: int):
    """Start SSH tunnel + Prisma Studio."""
    project = await get_prisma_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    server = await _resolve_server(project["server_id"])

    try:
        result = await asyncio.to_thread(
            prisma_start_project,
            project_id=project_id,
            ssh_host=server["host"],
            ssh_port=server["port"],
            ssh_user=server["user"],
            ssh_key_path=server.get("key_path") or None,
            database_url=project["database_url"],
            tunnel_port=project["tunnel_port"],
            studio_port=project["studio_port"],
            remote_schema_path=project["remote_schema_path"],
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/prisma/projects/{project_id}/stop")
async def api_stop_prisma(project_id: int):
    """Stop SSH tunnel + Prisma Studio."""
    project = await get_prisma_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    prisma_stop_project(project_id)
    return {"status": "stopped"}


@app.get("/api/prisma/projects/{project_id}/status")
async def api_prisma_status(project_id: int):
    """Check the status of a Prisma project."""
    project = await get_prisma_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    status = prisma_project_status(project_id)
    return {
        "status": status,
        "studio_url": f"http://127.0.0.1:{project['studio_port']}",
    }


@app.post("/api/prisma/projects/{project_id}/refresh")
async def api_refresh_prisma(project_id: int):
    """Re-download the schema from the remote server."""
    project = await get_prisma_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    server = await _resolve_server(project["server_id"])

    try:
        content = await asyncio.to_thread(
            prisma_refresh_schema,
            project_id=project_id,
            ssh_host=server["host"],
            ssh_port=server["port"],
            ssh_user=server["user"],
            ssh_key_path=server.get("key_path") or None,
            remote_schema_path=project["remote_schema_path"],
        )
        return {"success": True, "schema_length": len(content)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/prisma/projects/{project_id}")
async def api_delete_prisma_project(project_id: int):
    """Delete a Prisma project (stops it first if running)."""
    project = await get_prisma_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Stop if running
    prisma_stop_project(project_id)
    # Clean up local workspace
    prisma_cleanup_workspace(project_id)
    # Remove from database
    await delete_prisma_project(project_id)

    return {"success": True}


# ── Serve static frontend (production / Electron mode) ───

def _find_static_dir() -> str | None:
    """Find the frontend build dist directory."""
    # Environment variable takes priority (set by Electron)
    env_dir = os.environ.get("SSHADMIN_STATIC_DIR")
    if env_dir and os.path.isdir(env_dir):
        return os.path.abspath(env_dir)

    candidates = [
        # When launched from the backend directory
        os.path.join(os.path.dirname(__file__), "..", "frontend", "dist"),
        # When packaged with PyInstaller
        os.path.join(getattr(sys, "_MEIPASS", ""), "frontend_dist"),
        # Relative to CWD
        os.path.join(os.getcwd(), "frontend", "dist"),
        os.path.join(os.getcwd(), "frontend_dist"),
    ]
    for p in candidates:
        abspath = os.path.abspath(p)
        if os.path.isdir(abspath) and os.path.isfile(os.path.join(abspath, "index.html")):
            return abspath
    return None


_static_dir = _find_static_dir()
if _static_dir:
    from fastapi.responses import FileResponse

    # Mount static assets (JS, CSS, images)
    app.mount("/assets", StaticFiles(directory=os.path.join(_static_dir, "assets")), name="static-assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        """Serve the SPA frontend — all non-API routes return index.html."""
        file_path = os.path.join(_static_dir, full_path)
        if full_path and os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(_static_dir, "index.html"))


if __name__ == "__main__":
    import uvicorn
    is_packaged = getattr(sys, "frozen", False)
    uvicorn.run(
        "main:app" if not is_packaged else app,
        host="0.0.0.0",
        port=8765,
        reload=not is_packaged,
    )
