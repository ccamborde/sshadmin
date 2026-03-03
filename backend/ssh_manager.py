import paramiko
import json
import os
import re
import io
import time
import threading
from typing import Optional


# ── SSH Connection Pool ──────────────────────────────────────────
# Caches SSH connections by (host, user, port, key_path) to avoid
# re-doing the full handshake on every API call.
# Each entry: { "client": SSHClient, "last_used": float }
_ssh_pool: dict[tuple, dict] = {}
_pool_lock = threading.Lock()
_POOL_MAX_IDLE = 300  # seconds — evict connections idle for 5 min


def _pool_key(host: str, user: str, port: int, key_path: Optional[str]) -> tuple:
    return (host, user, port, os.path.expanduser(key_path) if key_path else "")


def _is_client_alive(client: paramiko.SSHClient) -> bool:
    """Check if an SSH client's transport is still active."""
    try:
        transport = client.get_transport()
        return transport is not None and transport.is_active()
    except Exception:
        return False


def cleanup_ssh_pool():
    """Remove stale connections from the pool."""
    now = time.time()
    with _pool_lock:
        stale_keys = [
            k for k, v in _ssh_pool.items()
            if now - v["last_used"] > _POOL_MAX_IDLE or not _is_client_alive(v["client"])
        ]
        for k in stale_keys:
            try:
                _ssh_pool[k]["client"].close()
            except Exception:
                pass
            del _ssh_pool[k]
        if stale_keys:
            print(f"[ssh-pool] Cleaned up {len(stale_keys)} stale connection(s), {len(_ssh_pool)} remaining")


def _load_pkey(key_path: str) -> paramiko.PKey:
    """Load an SSH private key, supporting all common formats:
    - RSA classique (BEGIN RSA PRIVATE KEY)
    - PKCS#8 (BEGIN PRIVATE KEY)
    - OpenSSH (BEGIN OPENSSH PRIVATE KEY)
    - Ed25519, ECDSA
    - AWS .pem keys
    """
    key_path = os.path.expanduser(key_path)

    if not os.path.isfile(key_path):
        raise Exception(f"Key file not found: {key_path}")

    # 1) Paramiko PKey.from_path (handles OpenSSH format, Ed25519, etc.)
    try:
        return paramiko.PKey.from_path(key_path)
    except Exception:
        pass

    # 2) Essayer chaque type natif Paramiko
    for cls in [paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey]:
        try:
            return cls.from_private_key_file(key_path)
        except Exception:
            continue

    # 3) Fallback for PKCS#8 (BEGIN PRIVATE KEY) — via cryptography
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa, ec, ed25519

        with open(key_path, "rb") as f:
            raw = f.read()

        private_key = serialization.load_pem_private_key(raw, password=None)

        # Convertir en format PEM RSA classique que Paramiko comprend
        if isinstance(private_key, rsa.RSAPrivateKey):
            pem = private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
            return paramiko.RSAKey.from_private_key(io.StringIO(pem.decode()))

        if isinstance(private_key, ec.EllipticCurvePrivateKey):
            pem = private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
            return paramiko.ECDSAKey.from_private_key(io.StringIO(pem.decode()))

        if isinstance(private_key, ed25519.Ed25519PrivateKey):
            pem = private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.OpenSSH,
                encryption_algorithm=serialization.NoEncryption(),
            )
            return paramiko.Ed25519Key.from_private_key(io.StringIO(pem.decode()))

    except Exception as e:
        raise Exception(f"Unable to load key {key_path}: {e}")

    raise Exception(f"Unsupported key format: {key_path}")


def _find_default_keys() -> list[str]:
    """Return default SSH keys found in ~/.ssh/."""
    ssh_dir = os.path.expanduser("~/.ssh")
    default_names = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]
    found = []
    for name in default_names:
        path = os.path.join(ssh_dir, name)
        if os.path.isfile(path):
            found.append(path)
    return found


def _create_ssh_client(
    host: str,
    user: str,
    port: int = 22,
    key_path: Optional[str] = None,
    timeout: int = 20,
) -> paramiko.SSHClient:
    """Create a brand-new SSH client (no pool). Used internally."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    connect_kwargs = dict(
        hostname=host,
        username=user,
        port=port,
        timeout=timeout,
        look_for_keys=False,
        allow_agent=False,
    )

    if key_path:
        keys_to_try = [key_path]
    else:
        keys_to_try = _find_default_keys()

    last_error = None
    for kp in keys_to_try:
        try:
            pkey = _load_pkey(kp)
            connect_kwargs["pkey"] = pkey
            client.connect(**connect_kwargs)
            return client
        except Exception as e:
            last_error = e
            continue

    # Last resort: try SSH agent + look_for_keys
    try:
        connect_kwargs.pop("pkey", None)
        connect_kwargs["allow_agent"] = True
        connect_kwargs["look_for_keys"] = True
        client.connect(**connect_kwargs)
        return client
    except Exception as e:
        raise last_error if last_error else e


def get_ssh_client(
    host: str,
    user: str,
    port: int = 22,
    key_path: Optional[str] = None,
    timeout: int = 20,
) -> paramiko.SSHClient:
    """Get an SSH client from the connection pool (or create a new one).

    The returned client is SHARED — do NOT call client.close() on it.
    It will be kept alive in the pool for reuse.
    """
    key = _pool_key(host, user, port, key_path)

    with _pool_lock:
        if key in _ssh_pool:
            entry = _ssh_pool[key]
            if _is_client_alive(entry["client"]):
                entry["last_used"] = time.time()
                return entry["client"]
            else:
                # Dead connection, remove it
                try:
                    entry["client"].close()
                except Exception:
                    pass
                del _ssh_pool[key]

    # Create new connection (outside lock to avoid blocking)
    client = _create_ssh_client(host, user, port, key_path, timeout)

    with _pool_lock:
        # Double-check: another thread may have created one in the meantime
        if key in _ssh_pool and _is_client_alive(_ssh_pool[key]["client"]):
            # Use the one already in the pool, close ours
            client.close()
            _ssh_pool[key]["last_used"] = time.time()
            return _ssh_pool[key]["client"]
        _ssh_pool[key] = {"client": client, "last_used": time.time()}

    print(f"[ssh-pool] New connection to {user}@{host}:{port} (pool size: {len(_ssh_pool)})")
    return client


def get_ssh_client_new(
    host: str,
    user: str,
    port: int = 22,
    key_path: Optional[str] = None,
    timeout: int = 20,
) -> paramiko.SSHClient:
    """Create an exclusive (non-pooled) SSH client. Caller MUST close() it.

    Use this for long-lived connections like log streaming.
    """
    return _create_ssh_client(host, user, port, key_path, timeout)


def test_connection(host: str, user: str, port: int = 22, key_path: Optional[str] = None) -> dict:
    """Test SSH connection to a server."""
    try:
        client = get_ssh_client(host, user, port, key_path)
        stdin, stdout, stderr = client.exec_command("hostname && uname -s -r")
        info = stdout.read().decode("utf-8").strip()
        return {"success": True, "message": f"Connection successful — {info}"}
    except Exception as e:
        return {"success": False, "message": str(e)}


def list_containers(host: str, user: str, port: int = 22, key_path: Optional[str] = None) -> list[dict]:
    """List Docker containers on a remote server."""
    try:
        client = get_ssh_client(host, user, port, key_path)
        cmd = 'docker ps -a --format \'{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","state":"{{.State}}","ports":"{{.Ports}}","created":"{{.CreatedAt}}"}\''
        stdin, stdout, stderr = client.exec_command(cmd)
        output = stdout.read().decode("utf-8").strip()
        errors = stderr.read().decode("utf-8").strip()

        if errors and not output:
            return []

        containers = []
        for line in output.split("\n"):
            line = line.strip()
            if line:
                try:
                    container = json.loads(line)
                    containers.append(container)
                except json.JSONDecodeError:
                    continue

        return containers
    except Exception as e:
        raise Exception(f"SSH error: {str(e)}")


def get_container_logs(
    host: str,
    user: str,
    container_id: str,
    port: int = 22,
    key_path: Optional[str] = None,
    tail: int = 200,
    since: Optional[str] = None,
) -> list[dict]:
    """Retrieve and parse logs from a Docker container."""
    try:
        client = get_ssh_client(host, user, port, key_path)

        cmd = f"docker logs --tail {tail} --timestamps"
        if since:
            cmd += f" --since {since}"
        cmd += f" {container_id} 2>&1"

        stdin, stdout, stderr = client.exec_command(cmd)
        output = stdout.read().decode("utf-8", errors="replace").strip()

        if not output:
            return []

        return parse_docker_logs(output)
    except Exception as e:
        raise Exception(f"SSH error: {str(e)}")


def stream_container_logs(
    host: str,
    user: str,
    container_id: str,
    port: int = 22,
    key_path: Optional[str] = None,
    tail: int = 50,
):
    """Generator that streams Docker container logs in real-time.
    Uses an exclusive (non-pooled) connection since it's long-lived.
    """
    client = get_ssh_client_new(host, user, port, key_path)
    cmd = f"docker logs --follow --tail {tail} --timestamps {container_id} 2>&1"
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=True)

    try:
        for line in iter(stdout.readline, ""):
            if not line:
                break
            yield line.rstrip("\n")
    finally:
        client.close()


def docker_action(
    host: str,
    user: str,
    container_id: str,
    action: str,
    port: int = 22,
    key_path: Optional[str] = None,
) -> dict:
    """Execute a Docker action on a remote container."""
    allowed_actions = {
        "start":   "docker start {cid}",
        "stop":    "docker stop {cid}",
        "restart": "docker restart {cid}",
        "kill":    "docker kill {cid}",
        "pause":   "docker pause {cid}",
        "unpause": "docker unpause {cid}",
        "remove":  "docker rm -f {cid}",
    }

    if action not in allowed_actions:
        raise Exception(f"Unknown action: {action}")

    try:
        client = get_ssh_client(host, user, port, key_path)
        cmd = allowed_actions[action].format(cid=container_id)
        stdin, stdout, stderr = client.exec_command(cmd)
        output = stdout.read().decode("utf-8").strip()
        errors = stderr.read().decode("utf-8").strip()
        exit_code = stdout.channel.recv_exit_status()

        if exit_code != 0:
            raise Exception(errors or f"Command failed (code {exit_code})")

        return {"success": True, "message": f"Action '{action}' executed successfully", "output": output}
    except Exception as e:
        raise Exception(f"Docker error: {str(e)}")


def docker_inspect(
    host: str,
    user: str,
    container_id: str,
    port: int = 22,
    key_path: Optional[str] = None,
) -> dict:
    """Retrieve full details of a Docker container."""
    try:
        client = get_ssh_client(host, user, port, key_path)
        cmd = f"docker inspect {container_id}"
        stdin, stdout, stderr = client.exec_command(cmd)
        output = stdout.read().decode("utf-8").strip()

        data = json.loads(output)
        if isinstance(data, list) and len(data) > 0:
            return data[0]
        return data
    except json.JSONDecodeError:
        raise Exception("Unable to parse container data")
    except Exception as e:
        raise Exception(f"SSH error: {str(e)}")


def get_all_containers_logs(
    host: str,
    user: str,
    port: int = 22,
    key_path: Optional[str] = None,
    tail: int = 30,
    since: Optional[str] = None,
) -> list[dict]:
    """Retrieve logs from ALL running containers, with container name."""
    try:
        client = get_ssh_client(host, user, port, key_path)

        # 1) List running containers
        cmd_ps = "docker ps --format '{{.ID}} {{.Names}}'"
        stdin, stdout, stderr = client.exec_command(cmd_ps)
        ps_output = stdout.read().decode("utf-8").strip()

        if not ps_output:
            return []

        containers = {}
        for line in ps_output.split("\n"):
            parts = line.strip().split(" ", 1)
            if len(parts) == 2:
                containers[parts[0]] = parts[1]

        # 2) Build a bash script that retrieves logs from all containers
        script_parts = []
        for cid, cname in containers.items():
            since_flag = f"--since '{since}'" if since else ""
            script_parts.append(
                f"docker logs --tail {tail} --timestamps {since_flag} {cid} 2>&1 | "
                f"sed 's/^/[{cname}] /'"
            )

        full_script = " & ".join(script_parts) + " & wait"
        stdin, stdout, stderr = client.exec_command(full_script)
        output = stdout.read().decode("utf-8", errors="replace").strip()

        if not output:
            return []

        return parse_multi_container_logs(output, containers)
    except Exception as e:
        raise Exception(f"SSH error: {str(e)}")


def stream_all_containers_logs(
    host: str,
    user: str,
    port: int = 22,
    key_path: Optional[str] = None,
    tail: int = 5,
):
    """Generator that streams ALL running container logs in real-time.
    Uses an exclusive (non-pooled) connection since it's long-lived.
    """
    client = get_ssh_client_new(host, user, port, key_path)

    script = (
        "for cid in $(docker ps -q); do "
        "  cname=$(docker inspect --format '{{.Name}}' $cid | sed 's|^/||'); "
        f"  docker logs --follow --tail {tail} --timestamps $cid 2>&1 | "
        "  sed -u \"s/^/[$cname] /\" & "
        "done; wait"
    )

    stdin, stdout, stderr = client.exec_command(script, get_pty=True)

    try:
        for line in iter(stdout.readline, ""):
            if not line:
                break
            yield line.rstrip("\n")
    finally:
        client.close()


def get_server_stats(
    host: str,
    user: str,
    port: int = 22,
    key_path: Optional[str] = None,
) -> dict:
    """Retrieve system stats (CPU, RAM, swap) from a remote server."""
    try:
        client = get_ssh_client(host, user, port, key_path)

        cmd = (
            "echo '===LOADAVG===' && cat /proc/loadavg && "
            "echo '===MEMINFO===' && grep -E "
            "'^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' "
            "/proc/meminfo && "
            "echo '===NPROC===' && nproc"
        )

        stdin, stdout, stderr = client.exec_command(cmd, timeout=10)
        output = stdout.read().decode("utf-8", errors="replace").strip()

        return _parse_linux_stats(output)
    except Exception as e:
        return {"error": str(e)}


def _parse_linux_stats(output: str) -> dict:
    """Parse la sortie des commandes de statistiques Linux."""
    load_avg = [0.0, 0.0, 0.0]
    mem_total = 0
    mem_available = 0
    mem_free = 0
    buffers = 0
    cached = 0
    swap_total = 0
    swap_free = 0
    nproc = 1

    section = None
    for line in output.split("\n"):
        line = line.strip()
        if line == "===LOADAVG===":
            section = "loadavg"
            continue
        elif line == "===MEMINFO===":
            section = "meminfo"
            continue
        elif line == "===NPROC===":
            section = "nproc"
            continue

        if section == "loadavg" and line:
            parts = line.split()
            if len(parts) >= 3:
                try:
                    load_avg = [float(parts[0]), float(parts[1]), float(parts[2])]
                except ValueError:
                    pass

        elif section == "meminfo" and line and ":" in line:
            key, value = line.split(":", 1)
            try:
                val_kb = int(value.strip().split()[0])
            except (ValueError, IndexError):
                continue
            if key == "MemTotal":
                mem_total = val_kb
            elif key == "MemAvailable":
                mem_available = val_kb
            elif key == "MemFree":
                mem_free = val_kb
            elif key == "Buffers":
                buffers = val_kb
            elif key == "Cached":
                cached = val_kb
            elif key == "SwapTotal":
                swap_total = val_kb
            elif key == "SwapFree":
                swap_free = val_kb

        elif section == "nproc" and line:
            try:
                nproc = int(line)
            except ValueError:
                pass

    # Used memory
    if mem_available > 0:
        mem_used = mem_total - mem_available
    else:
        mem_used = mem_total - mem_free - buffers - cached

    swap_used = swap_total - swap_free

    mem_total_mb = round(mem_total / 1024)
    mem_used_mb = round(mem_used / 1024)
    swap_total_mb = round(swap_total / 1024)
    swap_used_mb = round(swap_used / 1024)

    cpu_percent = round(min((load_avg[0] / nproc) * 100, 100), 1)
    mem_percent = round((mem_used / mem_total * 100) if mem_total > 0 else 0, 1)
    swap_percent = round((swap_used / swap_total * 100) if swap_total > 0 else 0, 1)

    return {
        "cpu_percent": cpu_percent,
        "cpu_cores": nproc,
        "load_avg": [round(l, 2) for l in load_avg],
        "mem_total_mb": mem_total_mb,
        "mem_used_mb": mem_used_mb,
        "mem_percent": mem_percent,
        "swap_total_mb": swap_total_mb,
        "swap_used_mb": swap_used_mb,
        "swap_percent": swap_percent,
    }


def parse_multi_container_logs(raw_output: str, containers: dict) -> list[dict]:
    """Parse multi-container logs (prefixed with [container_name])."""
    lines = raw_output.split("\n")
    parsed = []

    container_pattern = re.compile(r"^\[([^\]]+)\]\s*(.*)")
    ts_pattern = re.compile(r"^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(.*)")
    level_patterns = {
        "error": re.compile(r"\b(ERROR|ERR|FATAL|CRITICAL|PANIC)\b", re.IGNORECASE),
        "warn": re.compile(r"\b(WARN|WARNING)\b", re.IGNORECASE),
        "info": re.compile(r"\b(INFO|NOTICE)\b", re.IGNORECASE),
        "debug": re.compile(r"\b(DEBUG|TRACE)\b", re.IGNORECASE),
    }

    for line in lines:
        if not line.strip():
            continue

        container_name = None
        rest = line

        # Extraire le nom du container
        cm = container_pattern.match(line)
        if cm:
            container_name = cm.group(1)
            rest = cm.group(2)

        timestamp = None
        message = rest

        # Extraire le timestamp
        ts_match = ts_pattern.match(rest)
        if ts_match:
            timestamp = ts_match.group(1)
            message = ts_match.group(2)

        # Niveau de log
        level = "info"
        for lvl, pattern in level_patterns.items():
            if pattern.search(message):
                level = lvl
                break

        # JSON dans le message
        json_data = None
        json_match = re.search(r"\{.*\}", message)
        if json_match:
            try:
                json_data = json.loads(json_match.group())
            except json.JSONDecodeError:
                pass

        parsed.append({
            "timestamp": timestamp,
            "level": level,
            "message": message,
            "container_name": container_name,
            "json_data": json_data,
            "raw": line,
        })

    # Trier par timestamp
    parsed.sort(key=lambda x: x["timestamp"] or "")

    return parsed


def parse_docker_logs(raw_output: str) -> list[dict]:
    """Parse raw Docker logs into structured objects with log level."""
    lines = raw_output.split("\n")
    parsed = []

    # Regex pour timestamp Docker
    ts_pattern = re.compile(r"^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(.*)")
    # Patterns to detect log levels
    level_patterns = {
        "error": re.compile(r"\b(ERROR|ERR|FATAL|CRITICAL|PANIC)\b", re.IGNORECASE),
        "warn": re.compile(r"\b(WARN|WARNING)\b", re.IGNORECASE),
        "info": re.compile(r"\b(INFO|NOTICE)\b", re.IGNORECASE),
        "debug": re.compile(r"\b(DEBUG|TRACE)\b", re.IGNORECASE),
    }

    for line in lines:
        if not line.strip():
            continue

        timestamp = None
        message = line

        # Extract timestamp if present
        ts_match = ts_pattern.match(line)
        if ts_match:
            timestamp = ts_match.group(1)
            message = ts_match.group(2)

        # Detect log level
        level = "info"
        for lvl, pattern in level_patterns.items():
            if pattern.search(message):
                level = lvl
                break

        # Tenter de parser du JSON dans le message
        json_data = None
        json_match = re.search(r"\{.*\}", message)
        if json_match:
            try:
                json_data = json.loads(json_match.group())
            except json.JSONDecodeError:
                pass

        parsed.append({
            "timestamp": timestamp,
            "level": level,
            "message": message,
            "json_data": json_data,
            "raw": line,
        })

    return parsed
