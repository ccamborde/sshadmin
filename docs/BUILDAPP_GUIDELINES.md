# SSH Admin — Build Guidelines

How to build the SSH Admin macOS Electron application from source.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | >= 18 | Electron & frontend build |
| **npm** | >= 9 | Package management |
| **Python** | >= 3.11 | Backend (FastAPI) |
| **Docker** | any | Optional — for local container monitoring |

---

## Project Structure

```
sshadmin/
├── backend/               # Python FastAPI backend
│   ├── main.py            # Entry point
│   ├── database.py        # SQLite persistence
│   ├── ssh_manager.py     # SSH/Docker remote commands
│   ├── local_docker.py    # Local Docker commands (no SSH)
│   ├── sshadmin.spec      # PyInstaller spec
│   └── requirements.txt   # Python dependencies
├── frontend/              # React + Vite + TailwindCSS
│   ├── src/
│   ├── index.html
│   └── package.json
├── electron/              # Electron main process
│   ├── main.js
│   └── preload.js
├── build/                 # Build resources (icons, entitlements)
├── scripts/               # Build scripts
│   ├── build-backend.sh   # PyInstaller build
│   └── build-app.sh       # Full build pipeline
├── package.json           # Root — Electron + electron-builder config
└── docs/
```

---

## Initial Setup

### 1. Create the Python virtual environment

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
pip install pyinstaller
```

### 2. Install Node.js dependencies

```bash
# Root (Electron + electron-builder)
npm install

# Frontend (React + Vite) — automatically done via postinstall
cd frontend && npm install
```

---

## Development Mode

Run the backend and frontend separately for hot-reload:

```bash
# Terminal 1 — Backend
source venv/bin/activate
cd backend && python main.py

# Terminal 2 — Frontend (Vite dev server with proxy)
cd frontend && npm run dev
```

Then open http://localhost:3000 in your browser.

### Electron Dev Mode

To run the app inside Electron (without packaging):

```bash
# Make sure the backend is NOT already running on port 8765
npm run dev
```

This will:
1. Start the Python backend as a child process
2. Open the Electron window pointing to `http://127.0.0.1:8765`

---

## Building the Application

### Quick Build (current architecture)

```bash
./scripts/build-app.sh
```

### Build for a Specific Architecture

```bash
# Intel (x64)
./scripts/build-app.sh x64

# Apple Silicon (arm64)
./scripts/build-app.sh arm64

# Universal binary (both) — requires native deps for both archs
./scripts/build-app.sh universal
```

### Step-by-Step Manual Build

If you prefer to run each step individually:

#### Step 1 — Build the frontend

```bash
cd frontend
npm run build
```

Output: `frontend/dist/` (static HTML/JS/CSS files)

#### Step 2 — Build the backend

```bash
./scripts/build-backend.sh
```

Output: `dist-backend/sshadmin-backend` (standalone binary, ~21 MB)

#### Step 3 — Package with Electron

```bash
# Intel
npx electron-builder --mac --x64

# Apple Silicon
npx electron-builder --mac --arm64

# Both architectures
npx electron-builder --mac
```

Output: `release/` directory containing `.dmg` and `.zip` files.

---

## Build Output

After a successful build, you will find in `release/`:

| File | Description |
|------|-------------|
| `SSH Admin-x.y.z.dmg` | DMG installer for Intel Macs |
| `SSH Admin-x.y.z-arm64.dmg` | DMG installer for Apple Silicon Macs |
| `SSH Admin-x.y.z-mac.zip` | ZIP archive for Intel Macs |
| `SSH Admin-x.y.z-arm64-mac.zip` | ZIP archive for Apple Silicon Macs |

The `.app` bundle is also available in `release/mac/` (Intel) and `release/mac-arm64/` (Apple Silicon).

---

## Application Architecture (Packaged)

```
SSH Admin.app/Contents/
├── MacOS/
│   └── SSH Admin              ← Electron binary
├── Resources/
│   ├── app.asar               ← Electron JS code (main.js, preload.js)
│   ├── backend/
│   │   └── sshadmin-backend   ← Python backend (PyInstaller standalone)
│   └── frontend_dist/
│       ├── index.html         ← React SPA
│       └── assets/            ← JS + CSS bundles
```

**Startup flow:**

1. Electron launches and spawns `sshadmin-backend` as a child process
2. The backend starts FastAPI on port `8765` and serves the static frontend
3. Electron opens a `BrowserWindow` pointing to `http://127.0.0.1:8765`
4. On quit, Electron sends `SIGTERM` to the backend process

---

## Code Signing (Optional)

The build skips code signing by default. To sign the app for distribution:

1. Obtain an **Apple Developer ID Application** certificate
2. Set the environment variables:

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
# or
export CSC_LINK="/path/to/certificate.p12"
export CSC_KEY_PASSWORD="your-password"
```

3. Rebuild — `electron-builder` will automatically sign the app.

For notarization (required for distribution outside the Mac App Store):

```bash
export APPLE_ID="your@apple.id"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
```

Refer to [electron-builder Code Signing docs](https://www.electron.build/code-signing) for details.

---

## Troubleshooting

### Port 8765 already in use

The backend defaults to port 8765. If another process is using it:

```bash
lsof -i :8765
kill -9 <PID>
```

### PyInstaller build fails

Make sure you are inside the virtual environment:

```bash
source venv/bin/activate
which pyinstaller  # should point to venv/bin/pyinstaller
```

### Cross-architecture build

To build an arm64 binary on an Intel Mac (or vice versa), you need:
- Python installed for the target architecture
- A separate venv with the target architecture's Python
- PyInstaller run under that Python

The simplest approach is to build on a machine with the target architecture.

### Frontend changes not reflected

Rebuild the frontend before packaging:

```bash
cd frontend && npm run build
```

---

## npm Scripts Reference

| Script | Description |
|--------|-------------|
| `npm run dev` | Run Electron in dev mode (starts backend + window) |
| `npm run build:frontend` | Build the React frontend |
| `npm run build:backend` | Build the Python backend with PyInstaller |
| `npm run build:electron:mac` | Package Electron app (both archs) |
| `npm run build:electron:mac-x64` | Package for Intel only |
| `npm run build:electron:mac-arm64` | Package for Apple Silicon only |
| `npm run build` | Full build pipeline (frontend + backend + Electron) |
