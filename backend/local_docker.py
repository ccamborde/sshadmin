"""
Local Docker command execution (no SSH).
Used for the virtual "localhost" server.
"""
import subprocess
import json
import re
import os
import platform
import threading
from typing import Optional


LOCALHOST_SERVER = {
    "id": "local",
    "name": "Localhost",
    "host": "localhost",
    "user": os.environ.get("USER", "local"),
    "port": 0,
    "key_path": "",
    "is_local": True,
}


def _run_cmd(cmd: str, timeout: int = 30) -> tuple[str, str, int]:
    """Execute a local shell command and return (stdout, stderr, exit_code)."""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return result.stdout.strip(), result.stderr.strip(), result.returncode
    except subprocess.TimeoutExpired:
        raise Exception(f"Command timed out after {timeout}s")
    except Exception as e:
        raise Exception(f"Erreur locale: {str(e)}")


def is_docker_available() -> bool:
    """Check if Docker is accessible locally."""
    try:
        stdout, stderr, code = _run_cmd("docker info --format '{{.ServerVersion}}'", timeout=5)
        return code == 0 and len(stdout) > 0
    except Exception:
        return False


def local_test_connection() -> dict:
    """Test local Docker availability."""
    try:
        stdout, _, code = _run_cmd("docker info --format '{{.ServerVersion}}'", timeout=5)
        if code == 0:
            hostname, _, _ = _run_cmd("hostname")
            uname, _, _ = _run_cmd("uname -s -r")
            return {"success": True, "message": f"Docker {stdout} — {hostname} {uname}"}
        return {"success": False, "message": "Docker n'est pas accessible"}
    except Exception as e:
        return {"success": False, "message": str(e)}


def local_list_containers() -> list[dict]:
    """Liste les containers Docker locaux."""
    cmd = "docker ps -a --format '{\"id\":\"{{.ID}}\",\"name\":\"{{.Names}}\",\"image\":\"{{.Image}}\",\"status\":\"{{.Status}}\",\"state\":\"{{.State}}\",\"ports\":\"{{.Ports}}\",\"created\":\"{{.CreatedAt}}\"}'"
    stdout, stderr, code = _run_cmd(cmd)

    if code != 0 or (not stdout and stderr):
        return []

    containers = []
    for line in stdout.split("\n"):
        line = line.strip()
        if line:
            try:
                containers.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return containers


def local_get_container_logs(
    container_id: str,
    tail: int = 200,
    since: Optional[str] = None,
) -> list[dict]:
    """Retrieve logs from a local Docker container."""
    cmd = f"docker logs --tail {tail} --timestamps"
    if since:
        cmd += f" --since {since}"
    cmd += f" {container_id} 2>&1"

    stdout, _, _ = _run_cmd(cmd, timeout=15)
    if not stdout:
        return []

    from ssh_manager import parse_docker_logs
    return parse_docker_logs(stdout)


def local_stream_container_logs(container_id: str, tail: int = 50):
    """Generator that streams local Docker container logs in real-time."""
    cmd = f"docker logs --follow --tail {tail} --timestamps {container_id}"
    process = subprocess.Popen(
        cmd, shell=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    try:
        for line in iter(process.stdout.readline, ""):
            if not line:
                break
            yield line.rstrip("\n")
    finally:
        process.kill()
        process.wait()


def local_docker_action(container_id: str, action: str) -> dict:
    """Execute a Docker action on a local container."""
    allowed_actions = {
        "start":   f"docker start {container_id}",
        "stop":    f"docker stop {container_id}",
        "restart": f"docker restart {container_id}",
        "kill":    f"docker kill {container_id}",
        "pause":   f"docker pause {container_id}",
        "unpause": f"docker unpause {container_id}",
        "remove":  f"docker rm -f {container_id}",
    }

    if action not in allowed_actions:
        raise Exception(f"Action inconnue: {action}")

    stdout, stderr, code = _run_cmd(allowed_actions[action])
    if code != 0:
        raise Exception(stderr or f"Command failed (code {code})")

    return {"success": True, "message": f"Action '{action}' executed successfully", "output": stdout}


def local_docker_inspect(container_id: str) -> dict:
    """Retrieve full details of a local Docker container."""
    stdout, _, code = _run_cmd(f"docker inspect {container_id}")
    if code != 0:
        raise Exception("Container introuvable")

    data = json.loads(stdout)
    if isinstance(data, list) and len(data) > 0:
        return data[0]
    return data


def local_get_all_containers_logs(tail: int = 30, since: Optional[str] = None) -> list[dict]:
    """Retrieve logs from ALL local running containers."""
    # 1) Lister les containers running
    stdout, _, code = _run_cmd("docker ps --format '{{.ID}} {{.Names}}'")
    if code != 0 or not stdout:
        return []

    containers = {}
    for line in stdout.split("\n"):
        parts = line.strip().split(" ", 1)
        if len(parts) == 2:
            containers[parts[0]] = parts[1]

    # 2) Retrieve logs from each container
    all_output_parts = []
    for cid, cname in containers.items():
        since_flag = f"--since '{since}'" if since else ""
        cmd = f"docker logs --tail {tail} --timestamps {since_flag} {cid} 2>&1 | sed 's/^/[{cname}] /'"
        stdout, _, _ = _run_cmd(cmd, timeout=15)
        if stdout:
            all_output_parts.append(stdout)

    if not all_output_parts:
        return []

    full_output = "\n".join(all_output_parts)
    from ssh_manager import parse_multi_container_logs
    return parse_multi_container_logs(full_output, containers)


def local_get_stats() -> dict:
    """Retrieve local system stats (CPU, RAM, swap)."""
    system = platform.system()
    try:
        if system == "Linux":
            return _local_linux_stats()
        elif system == "Darwin":
            return _local_macos_stats()
        else:
            return {"error": f"Unsupported system: {system}"}
    except Exception as e:
        return {"error": str(e)}


def _local_linux_stats() -> dict:
    """Local Linux system stats via /proc."""
    cmd = (
        "echo '===LOADAVG===' && cat /proc/loadavg && "
        "echo '===MEMINFO===' && grep -E "
        "'^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' "
        "/proc/meminfo && "
        "echo '===NPROC===' && nproc"
    )
    stdout, _, code = _run_cmd(cmd, timeout=5)
    if code != 0:
        return {"error": "Unable to retrieve system stats"}
    from ssh_manager import _parse_linux_stats
    return _parse_linux_stats(stdout)


def _local_macos_stats() -> dict:
    """Local macOS system stats."""
    # ── Load average ──
    load_avg = list(os.getloadavg())

    # ── CPU core count ──
    nproc_out, _, _ = _run_cmd("sysctl -n hw.ncpu", timeout=5)
    nproc = int(nproc_out) if nproc_out.strip() else 1

    # ── Total memory ──
    memsize_out, _, _ = _run_cmd("sysctl -n hw.memsize", timeout=5)
    mem_total_bytes = int(memsize_out) if memsize_out.strip() else 0
    mem_total_mb = round(mem_total_bytes / (1024 * 1024))

    # ── Used memory (vm_stat) ──
    vm_out, _, _ = _run_cmd("vm_stat", timeout=5)
    page_size = 16384
    pages = {"free": 0, "active": 0, "wired": 0, "compressed": 0}

    for line in vm_out.split("\n"):
        if "page size of" in line:
            m = re.search(r"page size of (\d+)", line)
            if m:
                page_size = int(m.group(1))
        elif "Pages free:" in line:
            pages["free"] = int(line.split(":")[1].strip().rstrip("."))
        elif "Pages active:" in line:
            pages["active"] = int(line.split(":")[1].strip().rstrip("."))
        elif "Pages wired down:" in line:
            pages["wired"] = int(line.split(":")[1].strip().rstrip("."))
        elif "Pages occupied by compressor:" in line:
            pages["compressed"] = int(line.split(":")[1].strip().rstrip("."))

    mem_used_bytes = (pages["active"] + pages["wired"] + pages["compressed"]) * page_size
    mem_used_mb = round(mem_used_bytes / (1024 * 1024))

    # ── Swap ──
    swap_out, _, _ = _run_cmd("sysctl vm.swapusage", timeout=5)
    swap_total_mb = 0
    swap_used_mb = 0
    if swap_out:
        total_m = re.search(r"total\s*=\s*([\d.]+)M", swap_out)
        used_m = re.search(r"used\s*=\s*([\d.]+)M", swap_out)
        if total_m:
            swap_total_mb = round(float(total_m.group(1)))
        if used_m:
            swap_used_mb = round(float(used_m.group(1)))

    # ── Calculate percentages ──
    cpu_percent = round(min((load_avg[0] / nproc) * 100, 100), 1)
    mem_percent = round((mem_used_mb / mem_total_mb * 100) if mem_total_mb > 0 else 0, 1)
    swap_percent = round((swap_used_mb / swap_total_mb * 100) if swap_total_mb > 0 else 0, 1)

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


def local_stream_all_containers_logs(tail: int = 5):
    """Generator that streams ALL local running container logs in real-time."""
    script = (
        "for cid in $(docker ps -q); do "
        "  cname=$(docker inspect --format '{{.Name}}' $cid | sed 's|^/||'); "
        f"  docker logs --follow --tail {tail} --timestamps $cid 2>&1 | "
        "  sed -u \"s/^/[$cname] /\" & "
        "done; wait"
    )

    process = subprocess.Popen(
        script, shell=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    try:
        for line in iter(process.stdout.readline, ""):
            if not line:
                break
            yield line.rstrip("\n")
    finally:
        process.kill()
        process.wait()
