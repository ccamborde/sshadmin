# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the SSH Admin backend.
Generates a standalone binary containing the FastAPI server and all dependencies.
"""

import sys
import os

block_cipher = None

# Backend directory
backend_dir = os.path.dirname(os.path.abspath(SPEC))

a = Analysis(
    [os.path.join(backend_dir, 'main.py')],
    pathex=[backend_dir],
    binaries=[],
    datas=[],
    hiddenimports=[
        'uvicorn',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'uvicorn.lifespan.off',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.http.httptools_impl',
        'uvicorn.protocols.websockets.wsproto_impl',
        'uvicorn.protocols.websockets.websockets_impl',
        'fastapi',
        'fastapi.middleware',
        'fastapi.middleware.cors',
        'fastapi.staticfiles',
        'fastapi.responses',
        'starlette',
        'starlette.responses',
        'starlette.staticfiles',
        'starlette.middleware',
        'starlette.middleware.cors',
        'starlette.routing',
        'starlette.websockets',
        'pydantic',
        'pydantic.fields',
        'aiosqlite',
        'paramiko',
        'paramiko.transport',
        'paramiko.rsakey',
        'paramiko.ecdsakey',
        'paramiko.ed25519key',
        'cryptography',
        'cryptography.hazmat.primitives.serialization',
        'cryptography.hazmat.primitives.asymmetric.rsa',
        'cryptography.hazmat.primitives.asymmetric.ec',
        'cryptography.hazmat.primitives.asymmetric.ed25519',
        'bcrypt',
        'nacl',
        'multipart',
        'python_multipart',
        'email_validator',
        'anyio',
        'anyio._backends._asyncio',
        'sniffio',
        # Project modules
        'database',
        'ssh_manager',
        'local_docker',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'PIL', 'scipy', 'numpy'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='sshadmin-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # No GUI, this is a server
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,  # Set via command line
    codesign_identity=None,
    entitlements_file=None,
)
