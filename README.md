# SSH Admin — Docker Monitor & Prisma Studio

A desktop application to monitor Docker containers across multiple remote servers via SSH, with built-in Prisma Studio integration for database browsing.

![Built with](https://img.shields.io/badge/Built%20with-React%20%2B%20FastAPI%20%2B%20Electron-blue)
![License](https://img.shields.io/badge/License-MIT-green)
![Platform](https://img.shields.io/badge/Platform-macOS-lightgrey)

## Features

### 🐳 Docker Monitoring
- **Multi-server management** — Add unlimited SSH servers and switch between them instantly
- **Container list** — View all running/stopped containers with real-time status, CPU, memory, and uptime
- **Container actions** — Start, stop, restart, pause, and kill containers with one click
- **Log viewer** — View container logs with syntax highlighting, JSON detection, and log level filtering
- **Live stream** — Aggregate real-time logs from all containers on a server into a single view with container color coding, pause/resume, search, and level/container filtering
- **Server stats** — Live CPU, RAM, and swap usage per server

### 🗄️ Prisma Studio Integration
- **Auto-detection** — Scans Docker containers for Prisma schema files and `DATABASE_URL` environment variables
- **One-click setup** — Detected schemas are added and started with a single click, no configuration needed
- **SSH tunneling** — Database traffic is securely routed through the SSH connection (no additional ports required on the server)
- **Embedded UI** — Prisma Studio runs locally and is displayed inline via an iframe for seamless database browsing
- **Multi-project** — Run multiple Prisma Studio instances simultaneously on different databases

### 🖥️ Desktop App
- **Electron wrapper** — Runs as a native macOS application with a bundled Python backend
- **Local Docker support** — Also monitors containers on localhost (no SSH required)
- **Dark theme** — Modern dark UI built with Tailwind CSS

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Electron Shell                     │
│  ┌────────────────────────────────────────────────┐  │
│  │          React Frontend (Vite + Tailwind)      │  │
│  │  ┌─────────┐ ┌──────────┐ ┌────────────────┐  │  │
│  │  │ Servers  │ │Containers│ │  Prisma Studio  │  │  │
│  │  │  List    │ │ + Logs   │ │   (iframe)      │  │  │
│  │  └─────────┘ └──────────┘ └────────────────┘  │  │
│  └──────────────────┬─────────────────────────────┘  │
│                     │ REST + WebSocket                │
│  ┌──────────────────▼─────────────────────────────┐  │
│  │          FastAPI Backend (Python)               │  │
│  │  ┌──────────┐ ┌────────────┐ ┌──────────────┐  │  │
│  │  │   SSH    │ │   Docker   │ │    Prisma     │  │  │
│  │  │ Manager  │ │  Commands  │ │   Manager     │  │  │
│  │  └──────────┘ └────────────┘ └──────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer    | Technology                          |
|----------|-------------------------------------|
| Frontend | React 18, Tailwind CSS, Lucide Icons |
| Backend  | Python 3.11+, FastAPI, Paramiko, aiosqlite |
| Desktop  | Electron 33                         |
| Build    | Vite, PyInstaller, electron-builder |

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **Python** >= 3.11
- **Docker** (optional, for local container monitoring)
- **npx** / **npm** (included with Node.js)

### Installation

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/sshadmin.git
cd sshadmin

# Python backend
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt

# Frontend
cd frontend && npm install && cd ..
```

### Pre-configure Servers (optional)

Copy `.env.example` to `.env` and add your servers:

```bash
cp .env.example .env
```

```env
# Format: SSHADMIN_SERVER_<n>=name|user@host:port|key_path
SSHADMIN_SERVER_1=staging|ec2-user@my-server.compute.amazonaws.com|~/.ssh/id_rsa
SSHADMIN_SERVER_2=production|deploy@prod.example.com:22|~/.ssh/prod.pem
```

Servers are auto-registered at startup. Duplicates (same host+user+port) are skipped.

### Development Mode

```bash
# Terminal 1 — Backend (auto-reload)
source venv/bin/activate
cd backend && python main.py

# Terminal 2 — Frontend (hot-reload on port 3000)
cd frontend && npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

Or use the helper script:

```bash
./start.sh
```

### Electron Dev Mode

```bash
npm install   # Install Electron dependencies
npm run dev   # Starts backend + Electron window
```

## Docker

```bash
# Build and run
docker compose up -d

# With a .env for pre-configured servers
docker compose up -d
docker compose cp .env sshadmin:/data/.env
docker compose restart
```

The container mounts `~/.ssh` (read-only) for SSH key access and persists data (SQLite DB, Prisma workspaces) in a Docker volume.

Open [http://localhost:8765](http://localhost:8765) in your browser.

## Building for macOS

```bash
# Full build (frontend + backend binary + Electron app)
./scripts/build-app.sh

# Specific architecture
./scripts/build-app.sh arm64      # Apple Silicon
./scripts/build-app.sh x64        # Intel
./scripts/build-app.sh universal  # Both
```

Output: `release/SSH Admin-x.y.z.dmg`

See [docs/BUILDAPP_GUIDELINES.md](docs/BUILDAPP_GUIDELINES.md) for detailed build instructions.

### Pre-configured Servers in Compiled App

For the compiled Electron app, place a `.env` file in `~/.sshadmin/.env`:

```bash
mkdir -p ~/.sshadmin
cat > ~/.sshadmin/.env << 'EOF'
SSHADMIN_SERVER_1=staging|ec2-user@my-server.compute.amazonaws.com|~/.ssh/id_rsa
EOF
```

The backend looks for `.env` in these locations (first match wins):
1. Project root (dev mode)
2. `~/.sshadmin/.env` (user config — works for compiled app)
3. Next to the executable (PyInstaller binary)
4. Electron Resources directory

## Usage

1. **Add a server** — Click `+` in the Servers panel, enter SSH credentials (host, user, port, key path)
2. **Browse containers** — Click a server to see its Docker containers, click a container for logs
3. **Live logs** — Switch to the "Live" tab for real-time aggregated logs from all containers
4. **Prisma Studio** — Switch to the "Prisma" tab, click the refresh button to scan containers for Prisma schemas, then click "Add" to start browsing the database

## Project Structure

```
sshadmin/
├── backend/                 # Python FastAPI backend
│   ├── main.py              # API endpoints
│   ├── database.py          # SQLite persistence
│   ├── ssh_manager.py       # SSH connections & Docker commands
│   ├── local_docker.py      # Local Docker support
│   ├── prisma_manager.py    # Prisma Studio lifecycle management
│   └── requirements.txt
├── frontend/                # React SPA
│   ├── src/
│   │   ├── App.jsx          # Main layout & routing
│   │   ├── api.js           # API client
│   │   └── components/      # UI components
│   └── package.json
├── electron/                # Electron main process
│   ├── main.js
│   └── preload.js
├── scripts/                 # Build scripts
├── build/                   # Build resources (icons, entitlements)
└── docs/                    # Documentation
```

## License

MIT
