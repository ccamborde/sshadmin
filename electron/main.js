const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

// ── Configuration ────────────────────────────────────────
const BACKEND_PORT = 8765;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

let mainWindow = null;
let backendProcess = null;

// ── Find backend binary ─────────────────────────────────
function getBackendPath() {
  const isPackaged = app.isPackaged;
  
  if (isPackaged) {
    // Production: binary is in Resources/backend/
    const resourcesPath = process.resourcesPath;
    const binaryName = process.platform === 'darwin' ? 'sshadmin-backend' : 'sshadmin-backend.exe';
    return {
      cmd: path.join(resourcesPath, 'backend', binaryName),
      args: [],
      cwd: path.join(resourcesPath, 'backend'),
      env: {
        // Tell the backend where the frontend dist is
        SSHADMIN_STATIC_DIR: path.join(resourcesPath, 'frontend_dist'),
        // Ensure Docker CLI and common tools are in PATH
        // (macOS Finder launches don't include /usr/local/bin)
        PATH: [
          process.env.PATH || '',
          '/usr/local/bin',
          '/opt/homebrew/bin',
          '/Applications/Docker.app/Contents/Resources/bin',
        ].join(':'),
      },
    };
  }
  
  // Development: use Python from the venv
  const projectRoot = path.join(__dirname, '..');
  return {
    cmd: path.join(projectRoot, 'venv', 'bin', 'python'),
    args: [path.join(projectRoot, 'backend', 'main.py')],
    cwd: projectRoot,
    env: {},
  };
}

// ── Start the backend ────────────────────────────────────
function startBackend() {
  return new Promise((resolve, reject) => {
    const backendInfo = getBackendPath();
    
    const { cmd, args, cwd, env: extraEnv } = backendInfo;
    
    console.log(`[Electron] Starting backend: ${cmd} ${args.join(' ')}`);
    
    backendProcess = spawn(cmd, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...extraEnv },
    });
    
    backendProcess.stdout.on('data', (data) => {
      console.log(`[Backend] ${data.toString().trim()}`);
    });
    
    backendProcess.stderr.on('data', (data) => {
      console.error(`[Backend] ${data.toString().trim()}`);
    });
    
    backendProcess.on('error', (err) => {
      console.error('[Electron] Backend start error:', err);
      reject(err);
    });
    
    backendProcess.on('exit', (code) => {
      console.log(`[Electron] Backend stopped (code ${code})`);
      backendProcess = null;
    });
    
    // Wait for the backend to be ready
    waitForBackend(30000)
      .then(resolve)
      .catch(reject);
  });
}

// ── Wait for the backend to respond ─────────────────────
function waitForBackend(timeout = 30000) {
  const startTime = Date.now();
  
  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - startTime > timeout) {
        reject(new Error('Timeout: backend not responding'));
        return;
      }
      
      const req = http.get(`${BACKEND_URL}/api/servers`, (res) => {
        if (res.statusCode === 200) {
          console.log('[Electron] Backend ready!');
          resolve();
        } else {
          setTimeout(check, 500);
        }
      });
      
      req.on('error', () => {
        setTimeout(check, 500);
      });
      
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(check, 500);
      });
    };
    
    // Small initial delay to let the process start
    setTimeout(check, 1000);
  });
}

// ── Stop the backend ─────────────────────────────────────
function stopBackend() {
  if (backendProcess) {
    console.log('[Electron] Stopping backend...');
    backendProcess.kill('SIGTERM');
    
    // Force kill after 5s if needed
    setTimeout(() => {
      if (backendProcess) {
        backendProcess.kill('SIGKILL');
      }
    }, 5000);
  }
}

// ── Create the main window ──────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    title: 'SSH Admin - Docker Monitor',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#0a0a0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });
  
  // Load frontend from the backend
  mainWindow.loadURL(BACKEND_URL);
  
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  
  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── macOS Menu ───────────────────────────────────────────
function createMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: 'About SSH Admin' },
        { type: 'separator' },
        { role: 'services', label: 'Services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide SSH Admin' },
        { role: 'hideOthers', label: 'Hide Others' },
        { role: 'unhide', label: 'Show All' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit SSH Admin' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'forceReload', label: 'Force Reload' },
        { role: 'toggleDevTools', label: 'Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual Size' },
        { role: 'zoomIn', label: 'Zoom In' },
        { role: 'zoomOut', label: 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Full Screen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize', label: 'Minimize' },
        { role: 'zoom', label: 'Zoom' },
        { type: 'separator' },
        { role: 'front', label: 'Bring All to Front' },
      ],
    },
  ];
  
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ────────────────────────────────────────

app.whenReady().then(async () => {
  createMenu();
  
  try {
    await startBackend();
    createWindow();
  } catch (err) {
    console.error('[Electron] Failed to start:', err);
    dialog.showErrorBox(
      'Startup Error',
      `Failed to start the backend:\n${err.message}\n\nMake sure port ${BACKEND_PORT} is available.`
    );
    app.quit();
  }
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep the app alive even without windows
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackend();
});

app.on('will-quit', () => {
  stopBackend();
});
