import aiosqlite
import os
from typing import Optional

# Allow overriding the DB directory via env (useful for Docker volumes)
_db_dir = os.environ.get("SSHADMIN_DB_DIR", os.path.dirname(__file__))
DB_PATH = os.path.join(_db_dir, "sshadmin.db")


async def get_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db


async def init_db():
    db = await get_db()
    try:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS servers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                user TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 22,
                key_path TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # Migration: add key_path if table already exists without this column
        try:
            await db.execute("ALTER TABLE servers ADD COLUMN key_path TEXT DEFAULT ''")
        except Exception:
            pass  # Column already exists
        # Unique constraint on (host, user, port)
        try:
            await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_unique ON servers (host, user, port)")
        except Exception:
            pass
        await db.commit()
    finally:
        await db.close()


async def server_exists(host: str, user: str, port: int = 22) -> bool:
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT 1 FROM servers WHERE host = ? AND user = ? AND port = ?",
            (host, user, port),
        )
        return await cursor.fetchone() is not None
    finally:
        await db.close()


async def add_server(name: str, host: str, user: str, port: int = 22, key_path: str = "") -> dict:
    if await server_exists(host, user, port):
        raise ValueError(f"Server {user}@{host}:{port} already exists")
    db = await get_db()
    try:
        cursor = await db.execute(
            "INSERT INTO servers (name, host, user, port, key_path) VALUES (?, ?, ?, ?, ?)",
            (name, host, user, port, key_path),
        )
        await db.commit()
        server_id = cursor.lastrowid
        return {"id": server_id, "name": name, "host": host, "user": user, "port": port, "key_path": key_path}
    finally:
        await db.close()


async def upsert_server(name: str, host: str, user: str, port: int = 22, key_path: str = "") -> tuple[dict, str]:
    """Insert or update a server. Returns (server_dict, 'added'|'updated'|'unchanged')."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT id, name, key_path FROM servers WHERE host = ? AND user = ? AND port = ?",
            (host, user, port),
        )
        existing = await cursor.fetchone()

        if existing:
            existing = dict(existing)
            changes = []
            if existing["name"] != name:
                changes.append("name")
            if (key_path or "") != (existing["key_path"] or ""):
                changes.append("key_path")

            if changes:
                await db.execute(
                    "UPDATE servers SET name = ?, key_path = ? WHERE id = ?",
                    (name, key_path, existing["id"]),
                )
                await db.commit()
                return {
                    "id": existing["id"], "name": name, "host": host,
                    "user": user, "port": port, "key_path": key_path,
                }, "updated"
            else:
                return {
                    "id": existing["id"], "name": existing["name"], "host": host,
                    "user": user, "port": port, "key_path": existing["key_path"],
                }, "unchanged"
        else:
            cursor = await db.execute(
                "INSERT INTO servers (name, host, user, port, key_path) VALUES (?, ?, ?, ?, ?)",
                (name, host, user, port, key_path),
            )
            await db.commit()
            return {
                "id": cursor.lastrowid, "name": name, "host": host,
                "user": user, "port": port, "key_path": key_path,
            }, "added"
    finally:
        await db.close()


async def get_servers() -> list[dict]:
    db = await get_db()
    try:
        cursor = await db.execute("SELECT id, name, host, user, port, key_path, created_at FROM servers ORDER BY created_at DESC")
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        await db.close()


async def get_server(server_id: int) -> Optional[dict]:
    db = await get_db()
    try:
        cursor = await db.execute("SELECT id, name, host, user, port, key_path FROM servers WHERE id = ?", (server_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def delete_server(server_id: int) -> bool:
    db = await get_db()
    try:
        cursor = await db.execute("DELETE FROM servers WHERE id = ?", (server_id,))
        await db.commit()
        return cursor.rowcount > 0
    finally:
        await db.close()


# ═════════════════════════════════════════════════════════════
#  Prisma Projects
# ═════════════════════════════════════════════════════════════

async def init_prisma_db():
    """Initialize the Prisma projects table."""
    db = await get_db()
    try:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS prisma_projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id TEXT NOT NULL,
                name TEXT NOT NULL,
                remote_schema_path TEXT NOT NULL,
                database_url TEXT NOT NULL,
                tunnel_port INTEGER NOT NULL,
                studio_port INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.commit()
    finally:
        await db.close()


async def add_prisma_project(
    server_id: str,
    name: str,
    remote_schema_path: str,
    database_url: str,
    tunnel_port: int,
    studio_port: int,
) -> dict:
    db = await get_db()
    try:
        cursor = await db.execute(
            "INSERT INTO prisma_projects (server_id, name, remote_schema_path, database_url, tunnel_port, studio_port) VALUES (?, ?, ?, ?, ?, ?)",
            (str(server_id), name, remote_schema_path, database_url, tunnel_port, studio_port),
        )
        await db.commit()
        return {
            "id": cursor.lastrowid,
            "server_id": str(server_id),
            "name": name,
            "remote_schema_path": remote_schema_path,
            "database_url": database_url,
            "tunnel_port": tunnel_port,
            "studio_port": studio_port,
        }
    finally:
        await db.close()


async def get_prisma_projects(server_id: str | None = None) -> list[dict]:
    db = await get_db()
    try:
        if server_id:
            cursor = await db.execute(
                "SELECT * FROM prisma_projects WHERE server_id = ? ORDER BY created_at DESC",
                (str(server_id),),
            )
        else:
            cursor = await db.execute(
                "SELECT * FROM prisma_projects ORDER BY created_at DESC"
            )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        await db.close()


async def get_prisma_project(project_id: int) -> dict | None:
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM prisma_projects WHERE id = ?", (project_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def delete_prisma_project(project_id: int) -> bool:
    db = await get_db()
    try:
        cursor = await db.execute(
            "DELETE FROM prisma_projects WHERE id = ?", (project_id,)
        )
        await db.commit()
        return cursor.rowcount > 0
    finally:
        await db.close()


async def get_used_prisma_ports() -> set[int]:
    """Return ports already used by Prisma projects."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT tunnel_port, studio_port FROM prisma_projects"
        )
        rows = await cursor.fetchall()
        ports = set()
        for row in rows:
            ports.add(row["tunnel_port"])
            ports.add(row["studio_port"])
        return ports
    finally:
        await db.close()


# ═════════════════════════════════════════════════════════════
#  Cache of Prisma schemas discovered in containers
# ═════════════════════════════════════════════════════════════

async def init_prisma_cache_db():
    """Initialize the Prisma schema cache table."""
    db = await get_db()
    try:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS prisma_schema_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id TEXT NOT NULL,
                container_name TEXT NOT NULL,
                schema_path TEXT NOT NULL,
                database_url TEXT DEFAULT '',
                last_scanned TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(server_id, container_name, schema_path)
            )
        """)
        await db.commit()
    finally:
        await db.close()


async def upsert_cached_schema(
    server_id: str,
    container_name: str,
    schema_path: str,
    database_url: str = "",
):
    """Insert or update a schema in the cache."""
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO prisma_schema_cache
                   (server_id, container_name, schema_path, database_url, last_scanned)
               VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(server_id, container_name, schema_path)
               DO UPDATE SET database_url = excluded.database_url,
                             last_scanned = CURRENT_TIMESTAMP
            """,
            (str(server_id), container_name, schema_path, database_url),
        )
        await db.commit()
    finally:
        await db.close()


async def get_cached_schemas(server_id: str) -> list[dict]:
    """Return cached schemas for a server."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM prisma_schema_cache WHERE server_id = ? ORDER BY container_name",
            (str(server_id),),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        await db.close()


async def clear_cached_schemas(server_id: str):
    """Clear the schema cache for a server."""
    db = await get_db()
    try:
        await db.execute(
            "DELETE FROM prisma_schema_cache WHERE server_id = ?",
            (str(server_id),),
        )
        await db.commit()
    finally:
        await db.close()


async def delete_cached_schema(cache_id: int):
    """Delete a cache entry."""
    db = await get_db()
    try:
        await db.execute("DELETE FROM prisma_schema_cache WHERE id = ?", (cache_id,))
        await db.commit()
    finally:
        await db.close()
