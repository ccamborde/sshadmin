"""
Gestionnaire Prisma Studio :
  - Recherche de fichiers schema.prisma sur les serveurs distants
  - SSH tunnel to PostgreSQL databases
  - Gestion des instances Prisma Studio locales
"""

import json
import os
import re
import select
import shutil
import socket
import subprocess
import threading
import time
from typing import Optional
from urllib.parse import urlparse

import paramiko

from ssh_manager import get_ssh_client, _load_pkey, _find_default_keys

# ── Local workspace directory ────────────────────────────────
_default_work_dir = os.path.join(os.path.dirname(__file__), ".prisma_workspaces")
_db_dir = os.environ.get("SSHADMIN_DB_DIR")
PRISMA_WORK_DIR = os.path.join(_db_dir, ".prisma_workspaces") if _db_dir else _default_work_dir
os.makedirs(PRISMA_WORK_DIR, exist_ok=True)

# ── Registry of active tunnels / studios ─────────────────────
_active_tunnels: dict[int, "SSHTunnel"] = {}
_active_studios: dict[int, subprocess.Popen] = {}
_studio_logs: dict[int, str] = {}  # project_id → chemin du fichier log


# ═════════════════════════════════════════════════════════════
#  Recherche de fichiers schema.prisma
# ═════════════════════════════════════════════════════════════

def find_schema_files(
    host: str,
    user: str,
    port: int = 22,
    key_path: Optional[str] = None,
) -> list[dict]:
    """Recherche les fichiers schema.prisma sur un serveur distant via SSH."""
    client = get_ssh_client(host, user, port, key_path)

    cmd = (
        "find /home /var /opt /srv /root /app /data "
        "-name 'schema.prisma' -type f "
        "-not -path '*/node_modules/*' "
        "-not -path '*/.git/*' "
        "-not -path '*/dist/*' "
        "-not -path '*/.prisma/*' "
        "2>/dev/null | head -50"
    )

    stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
    output = stdout.read().decode("utf-8").strip()
    client.close()

    if not output:
        return []

    results = []
    for line in output.split("\n"):
        path = line.strip()
        if not path or not path.endswith("schema.prisma"):
            continue

        parts = path.split("/")
        project_name = _guess_project_name(parts)

        results.append({
            "path": path,
            "project_name": project_name,
            "directory": "/".join(parts[:-1]),
        })

    return results


def _guess_project_name(path_parts: list[str]) -> str:
    """Guess the project name from the schema.prisma path."""
    for i, part in enumerate(path_parts):
        if part == "prisma" and i > 0:
            return path_parts[i - 1]
    if len(path_parts) >= 2:
        return path_parts[-2]
    return "unknown"


# ═════════════════════════════════════════════════════════════
#  Scan des containers Docker pour trouver des schemas Prisma
# ═════════════════════════════════════════════════════════════

_CONTAINER_BLACKLIST = {"buildx_buildkit", "buildkit"}


def _is_container_blacklisted(name: str) -> bool:
    """Filtre les containers de build (buildkit, etc.)."""
    lower = name.lower()
    return any(bl in lower for bl in _CONTAINER_BLACKLIST)


def scan_containers_for_schemas(
    host: str,
    user: str,
    port: int = 22,
    key_path: Optional[str] = None,
    container_names: list[str] | None = None,
) -> list[dict]:
    """Scanne les containers Docker pour trouver des schema.prisma.

    Retourne une liste de {container_name, schema_path, database_url}.
    """
    client = get_ssh_client(host, user, port, key_path)
    results = []

    try:
        # Si pas de liste fournie, lister les containers running
        if not container_names:
            stdin, stdout, stderr = client.exec_command(
                "docker ps --format '{{.Names}}'", timeout=10,
            )
            container_names = [
                n.strip() for n in stdout.read().decode("utf-8").strip().split("\n")
                if n.strip()
            ]

        if not container_names:
            return []

        # Filter blacklisted containers
        container_names = [c for c in container_names if not _is_container_blacklisted(c)]

        # Pour chaque container, chercher schema.prisma + DATABASE_URL
        for cname in container_names:
            try:
                find_cmd = (
                    f"docker exec {cname} sh -c \""
                    f"find / -maxdepth 6 -name 'schema.prisma' -type f "
                    f"-not -path '*/node_modules/*' "
                    f"-not -path '*/.prisma/*' "
                    f"-not -path '*/dist/*' "
                    f"-not -path '*/build/*' "
                    f"2>/dev/null | head -3"
                    f"\""
                )
                stdin, stdout, stderr = client.exec_command(find_cmd, timeout=15)
                schema_output = stdout.read().decode("utf-8").strip()

                if not schema_output:
                    continue

                for schema_path in schema_output.split("\n"):
                    schema_path = schema_path.strip()
                    if not schema_path or not schema_path.endswith("schema.prisma"):
                        continue

                    # Chercher DATABASE_URL :
                    # 1) dans les .env autour du schema
                    # 2) dans les variables d'environnement du container
                    schema_dir = "/".join(schema_path.split("/")[:-1])
                    parent_dir = "/".join(schema_path.split("/")[:-2])

                    db_url = ""

                    # Method 1: .env files
                    env_cmd = (
                        f"docker exec {cname} sh -c \""
                        f"cat '{parent_dir}/.env' '{schema_dir}/.env' "
                        f"'{parent_dir}/.env.production' '{parent_dir}/.env.local' "
                        f"2>/dev/null"
                        f"\""
                    )
                    stdin, stdout, stderr = client.exec_command(env_cmd, timeout=10)
                    env_content = stdout.read().decode("utf-8", errors="replace")

                    if env_content:
                        pg_match = re.search(
                            r"DATABASE_URL\s*=\s*[\"']?(postgres(?:ql)?://[^\s\"']+)",
                            env_content,
                        )
                        if pg_match:
                            db_url = pg_match.group(1)

                    # Method 2: container environment variables
                    if not db_url:
                        env_var_cmd = (
                            f"docker exec {cname} sh -c "
                            f"'printenv DATABASE_URL 2>/dev/null'"
                        )
                        stdin, stdout, stderr = client.exec_command(env_var_cmd, timeout=5)
                        env_var = stdout.read().decode("utf-8", errors="replace").strip()
                        if env_var and ("postgres" in env_var):
                            db_url = env_var

                    results.append({
                        "container_name": cname,
                        "schema_path": schema_path,
                        "database_url": db_url,
                    })

            except Exception:
                # Un container inaccessible ne bloque pas les autres
                continue

    finally:
        client.close()

    return results


def is_container_schema_path(path: str) -> bool:
    """Teste si le chemin est au format container:NAME:PATH."""
    return path.startswith("container:")


def parse_container_schema_path(path: str) -> tuple[str, str]:
    """Parse container:NAME:PATH → (container_name, file_path)."""
    parts = path.split(":", 2)
    if len(parts) != 3:
        raise ValueError(f"Format invalide: {path}")
    return parts[1], parts[2]


def get_container_file_content(
    host: str,
    user: str,
    port: int,
    key_path: Optional[str],
    container_name: str,
    file_path: str,
) -> Optional[str]:
    """Read the contents of a file inside a remote Docker container."""
    try:
        client = get_ssh_client(host, user, port, key_path)
        cmd = f"docker exec {container_name} cat '{file_path}'"
        stdin, stdout, stderr = client.exec_command(cmd, timeout=10)
        content = stdout.read().decode("utf-8")
        errors = stderr.read().decode("utf-8").strip()
        client.close()
        if errors and not content:
            return None
        return content
    except Exception:
        return None


# ═════════════════════════════════════════════════════════════
#  Lecture de fichiers distants (schema, .env)
# ═════════════════════════════════════════════════════════════

def get_remote_file_content(
    host: str,
    user: str,
    port: int,
    key_path: Optional[str],
    remote_path: str,
) -> Optional[str]:
    """Lit le contenu d'un fichier distant via SFTP."""
    try:
        client = get_ssh_client(host, user, port, key_path)
        sftp = client.open_sftp()
        with sftp.open(remote_path, "r") as f:
            content = f.read().decode("utf-8")
        sftp.close()
        client.close()
        return content
    except Exception:
        return None


def find_database_urls(
    host: str,
    user: str,
    port: int,
    key_path: Optional[str],
    schema_dir: str,
) -> dict[str, str]:
    """Cherche les DATABASE_URL dans les fichiers .env et docker-compose autour du schema."""
    client = get_ssh_client(host, user, port, key_path)

    # Build the list of directories to explore
    parts = schema_dir.rstrip("/").split("/")
    search_dirs = [schema_dir]
    if len(parts) > 1:
        parent = "/".join(parts[:-1])
        search_dirs.append(parent)
        if len(parts) > 2:
            grandparent = "/".join(parts[:-2])
            search_dirs.append(grandparent)
    search_dirs = list(dict.fromkeys(search_dirs))  # deduplicate

    pg_pattern = re.compile(
        r"(\w*DATABASE_URL\w*)\s*=\s*[\"']?(postgres(?:ql)?://[^\s\"']+)"
    )
    pg_url_pattern = re.compile(r"(postgres(?:ql)?://[^\s\"']+)")

    results = {}

    # 1) Recherche large : tous les fichiers .env* et docker-compose*
    #    in the project and nearby subdirectories
    search_root = search_dirs[-1]  # le dossier le plus haut
    cmd = (
        f"find '{search_root}' -maxdepth 4 "
        f"\\( -name '.env' -o -name '.env.*' -o -name '*.env' "
        f"-o -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' "
        f"-o -name 'compose.yml' -o -name 'compose.yaml' \\) "
        f"-type f -not -path '*/node_modules/*' "
        f"2>/dev/null | head -30"
    )
    stdin, stdout, stderr = client.exec_command(cmd, timeout=15)
    found_files = stdout.read().decode("utf-8").strip().split("\n")
    found_files = [f.strip() for f in found_files if f.strip()]

    for fpath in found_files:
        try:
            stdin, stdout, stderr = client.exec_command(
                f"cat '{fpath}' 2>/dev/null"
            )
            content = stdout.read().decode("utf-8", errors="replace").strip()
            if not content:
                continue

            fname = fpath.split("/")[-1]
            fdir = "/".join(fpath.split("/")[:-1])

            # Chercher les patterns DATABASE_URL=...
            for m in pg_pattern.finditer(content):
                label = f"{m.group(1)} ({fname} → {fdir})"
                results[label] = m.group(2)

            # Dans les docker-compose, chercher aussi les URLs postgres directes
            if "compose" in fname.lower():
                for m in pg_url_pattern.finditer(content):
                    url = m.group(1)
                    # Avoid duplicates
                    if url not in results.values():
                        label = f"PostgreSQL URL ({fname} → {fdir})"
                        results[label] = url
        except Exception:
            continue

    client.close()
    return results


# ═════════════════════════════════════════════════════════════
#  Parse DATABASE_URL
# ═════════════════════════════════════════════════════════════

def parse_database_url(url: str) -> dict:
    """Parse une DATABASE_URL PostgreSQL."""
    parsed = urlparse(url)
    return {
        "user": parsed.username or "postgres",
        "password": parsed.password or "",
        "host": parsed.hostname or "localhost",
        "port": parsed.port or 5432,
        "database": parsed.path.lstrip("/") or "postgres",
    }


# ═════════════════════════════════════════════════════════════
#  Gestion des ports
# ═════════════════════════════════════════════════════════════

def _wait_for_port(port: int, timeout: int = 15) -> bool:
    """Wait for a TCP port to be listening on 127.0.0.1."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(1)
                s.connect(("127.0.0.1", port))
                return True
        except (ConnectionRefusedError, OSError):
            time.sleep(0.5)
    return False


def _read_log(path: str, max_lines: int = 50) -> str:
    """Read the last lines of a log file."""
    try:
        with open(path, "r") as f:
            lines = f.readlines()
        return "".join(lines[-max_lines:])
    except Exception:
        return "(log indisponible)"


def find_free_port(
    start: int = 15432, end: int = 15600, exclude: set | None = None
) -> int:
    """Trouve un port TCP libre sur 127.0.0.1."""
    exclude = exclude or set()
    for p in range(start, end):
        if p in exclude:
            continue
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", p))
                return p
        except OSError:
            continue
    raise Exception(f"Aucun port libre dans la plage {start}-{end}")


# ═════════════════════════════════════════════════════════════
#  Tunnel SSH (local port forward via port 22)
# ═════════════════════════════════════════════════════════════

class SSHTunnel:
    """Tunnel SSH : 127.0.0.1:local_port → remote_host:remote_port via SSH (port 22).

    No additional ports are opened on the remote server.
    Tout passe par la connexion SSH existante.
    """

    def __init__(
        self,
        ssh_host: str,
        ssh_port: int,
        ssh_user: str,
        ssh_key_path: Optional[str],
        remote_host: str,
        remote_port: int,
        local_port: int,
    ):
        self.ssh_host = ssh_host
        self.ssh_port = int(ssh_port)
        self.ssh_user = ssh_user
        self.ssh_key_path = ssh_key_path
        self.remote_host = remote_host
        self.remote_port = int(remote_port)
        self.local_port = int(local_port)
        self._transport: Optional[paramiko.Transport] = None
        self._server_sock: Optional[socket.socket] = None
        self._running = False
        self._thread: Optional[threading.Thread] = None

    # ── SSH key resolution ───────────────────────────────

    def _resolve_pkey(self) -> paramiko.PKey:
        if self.ssh_key_path:
            return _load_pkey(self.ssh_key_path)
        for kp in _find_default_keys():
            try:
                return _load_pkey(kp)
            except Exception:
                continue
        raise Exception("No SSH key available for the tunnel")

    # ── Lifecycle ────────────────────────────────────────

    def start(self):
        pkey = self._resolve_pkey()

        self._transport = paramiko.Transport((self.ssh_host, self.ssh_port))
        self._transport.connect(username=self.ssh_user, pkey=pkey)

        self._server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server_sock.bind(("127.0.0.1", self.local_port))
        self._server_sock.listen(5)
        self._server_sock.settimeout(1.0)

        self._running = True
        self._thread = threading.Thread(
            target=self._accept_loop,
            daemon=True,
            name=f"ssh-tunnel-{self.local_port}",
        )
        self._thread.start()

    def stop(self):
        self._running = False
        if self._server_sock:
            try:
                self._server_sock.close()
            except Exception:
                pass
        if self._transport:
            try:
                self._transport.close()
            except Exception:
                pass

    @property
    def is_active(self) -> bool:
        return (
            self._running
            and self._transport is not None
            and self._transport.is_active()
        )

    # ── Accept loop ─────────────────────────────────────

    def _accept_loop(self):
        while self._running:
            try:
                client, addr = self._server_sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break

            try:
                chan = self._transport.open_channel(
                    "direct-tcpip",
                    (self.remote_host, self.remote_port),
                    addr,
                )
            except Exception:
                client.close()
                continue

            if chan is None:
                client.close()
                continue

            threading.Thread(
                target=self._forward,
                args=(client, chan),
                daemon=True,
            ).start()

    @staticmethod
    def _forward(local_sock: socket.socket, channel: paramiko.Channel):
        """Bidirectional transfer local ↔ SSH channel."""
        try:
            while True:
                r, _, _ = select.select([local_sock, channel], [], [], 5.0)
                if not r:
                    if channel.closed:
                        break
                    continue
                if local_sock in r:
                    data = local_sock.recv(8192)
                    if not data:
                        break
                    channel.sendall(data)
                if channel in r:
                    data = channel.recv(8192)
                    if not data:
                        break
                    local_sock.sendall(data)
        except Exception:
            pass
        finally:
            try:
                channel.close()
            except Exception:
                pass
            try:
                local_sock.close()
            except Exception:
                pass


# ═════════════════════════════════════════════════════════════
#  Espace de travail local pour un projet Prisma
# ═════════════════════════════════════════════════════════════

def prepare_workspace(
    project_id: int,
    schema_content: str,
    database_url: str,
    tunnel_port: int,
) -> str:
    """Create / update the local workspace for Prisma Studio."""
    work_dir = os.path.join(PRISMA_WORK_DIR, str(project_id))
    os.makedirs(work_dir, exist_ok=True)

    # Write schema.prisma
    with open(os.path.join(work_dir, "schema.prisma"), "w") as f:
        f.write(schema_content)

    # Build the tunneled DATABASE_URL
    db = parse_database_url(database_url)
    tunneled_url = (
        f"postgresql://{db['user']}:{db['password']}"
        f"@127.0.0.1:{tunnel_port}/{db['database']}"
    )

    # Write .env
    with open(os.path.join(work_dir, ".env"), "w") as f:
        f.write(f"DATABASE_URL={tunneled_url}\n")

    # package.json minimal
    pkg_path = os.path.join(work_dir, "package.json")
    if not os.path.isfile(pkg_path):
        with open(pkg_path, "w") as f:
            json.dump(
                {"name": f"prisma-studio-{project_id}", "private": True},
                f,
            )

    return work_dir


# ═════════════════════════════════════════════════════════════
#  Start / stop a project (tunnel + Prisma Studio)
# ═════════════════════════════════════════════════════════════

def start_project(
    project_id: int,
    ssh_host: str,
    ssh_port: int,
    ssh_user: str,
    ssh_key_path: Optional[str],
    database_url: str,
    tunnel_port: int,
    studio_port: int,
    remote_schema_path: str,
) -> dict:
    """Start the SSH tunnel + Prisma Studio for a project."""

    # Stop if already running
    stop_project(project_id)

    # 1) Download the latest schema (host or container)
    if is_container_schema_path(remote_schema_path):
        cname, fpath = parse_container_schema_path(remote_schema_path)
        schema_content = get_container_file_content(
            ssh_host, ssh_user, ssh_port, ssh_key_path, cname, fpath,
        )
    else:
        schema_content = get_remote_file_content(
            ssh_host, ssh_user, ssh_port, ssh_key_path, remote_schema_path,
        )
    if not schema_content:
        raise Exception(f"Impossible de lire {remote_schema_path}")

    # 2) Prepare the workspace
    work_dir = prepare_workspace(
        project_id, schema_content, database_url, tunnel_port,
    )

    # 3) Parser la DB URL pour le tunnel
    db = parse_database_url(database_url)

    # 4) Start the SSH tunnel (all traffic goes through port 22)
    tunnel = SSHTunnel(
        ssh_host, ssh_port, ssh_user, ssh_key_path,
        db["host"], db["port"], tunnel_port,
    )
    tunnel.start()
    _active_tunnels[project_id] = tunnel

    # Wait for the tunnel to be ready
    time.sleep(1.5)
    if not tunnel.is_active:
        tunnel.stop()
        _active_tunnels.pop(project_id, None)
        raise Exception("SSH tunnel failed to start")

    # 5) Start Prisma Studio
    schema_path = os.path.join(work_dir, "schema.prisma")
    cmd = [
        "npx", "--yes", "prisma", "studio",
        "--schema", schema_path,
        "--port", str(studio_port),
        "--browser", "none",
    ]

    # Redirect stdout/stderr to a log file (not PIPE to avoid
    # le blocage quand le buffer se remplit et que personne ne le lit)
    log_path = os.path.join(work_dir, "studio.log")
    log_file = open(log_path, "w")

    proc = subprocess.Popen(
        cmd,
        cwd=work_dir,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
        env={**os.environ, "BROWSER": "none"},
    )
    _active_studios[project_id] = proc
    _studio_logs[project_id] = log_path

    # Wait for Prisma Studio to actually be ready (port listening)
    ready = _wait_for_port(studio_port, timeout=15)

    if proc.poll() is not None:
        # Process terminated immediately — error
        log_file.close()
        output = _read_log(log_path)
        tunnel.stop()
        _active_tunnels.pop(project_id, None)
        _active_studios.pop(project_id, None)
        raise Exception(f"Prisma Studio failed to start:\n{output}")

    if not ready:
        # Process is running but still not listening
        log_file.close()
        output = _read_log(log_path)
        # Tuer le processus zombie
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            proc.kill()
        tunnel.stop()
        _active_tunnels.pop(project_id, None)
        _active_studios.pop(project_id, None)
        raise Exception(
            f"Prisma Studio is not listening on port {studio_port} "
            f"after 15s:\n{output}"
        )

    return {
        "tunnel_port": tunnel_port,
        "studio_port": studio_port,
        "studio_url": f"http://127.0.0.1:{studio_port}",
        "status": "running",
    }


def stop_project(project_id: int):
    """Stop the SSH tunnel and Prisma Studio."""
    # Stop Studio
    proc = _active_studios.pop(project_id, None)
    if proc:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    # Remove log reference
    _studio_logs.pop(project_id, None)

    # Stop Tunnel
    tunnel = _active_tunnels.pop(project_id, None)
    if tunnel:
        tunnel.stop()


def project_status(project_id: int) -> str:
    """Check project status: running | partial | stopped."""
    tunnel = _active_tunnels.get(project_id)
    studio = _active_studios.get(project_id)

    tunnel_ok = tunnel is not None and tunnel.is_active
    studio_ok = studio is not None and studio.poll() is None

    if tunnel_ok and studio_ok:
        return "running"
    elif tunnel_ok or studio_ok:
        # One of them is down — stop everything for a clean state
        stop_project(project_id)
        return "stopped"
    else:
        # Clean up dead references
        _active_tunnels.pop(project_id, None)
        _active_studios.pop(project_id, None)
        _studio_logs.pop(project_id, None)
        return "stopped"


def get_studio_log(project_id: int) -> str:
    """Retourne le contenu du log Prisma Studio (pour debug)."""
    log_path = _studio_logs.get(project_id)
    if not log_path:
        log_path = os.path.join(PRISMA_WORK_DIR, str(project_id), "studio.log")
    return _read_log(log_path)


def refresh_schema(
    project_id: int,
    ssh_host: str,
    ssh_port: int,
    ssh_user: str,
    ssh_key_path: Optional[str],
    remote_schema_path: str,
) -> str:
    """Re-download schema.prisma from the remote server or container."""
    if is_container_schema_path(remote_schema_path):
        cname, fpath = parse_container_schema_path(remote_schema_path)
        content = get_container_file_content(
            ssh_host, ssh_user, ssh_port, ssh_key_path, cname, fpath,
        )
    else:
        content = get_remote_file_content(
            ssh_host, ssh_user, ssh_port, ssh_key_path, remote_schema_path,
        )
    if not content:
        raise Exception(f"Impossible de lire {remote_schema_path}")

    work_dir = os.path.join(PRISMA_WORK_DIR, str(project_id))
    os.makedirs(work_dir, exist_ok=True)
    with open(os.path.join(work_dir, "schema.prisma"), "w") as f:
        f.write(content)

    return content


def cleanup_all():
    """Stop all active projects (called on server shutdown)."""
    for pid in list(_active_tunnels.keys()):
        stop_project(pid)


def cleanup_workspace(project_id: int):
    """Supprime l'espace de travail local d'un projet."""
    work_dir = os.path.join(PRISMA_WORK_DIR, str(project_id))
    if os.path.isdir(work_dir):
        shutil.rmtree(work_dir, ignore_errors=True)
