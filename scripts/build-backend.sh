#!/bin/bash
# ─────────────────────────────────────────────────────────
# Build the Python backend with PyInstaller
# Produces a standalone binary in dist-backend/
# ─────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
VENV_DIR="$PROJECT_ROOT/venv"
OUTPUT_DIR="$PROJECT_ROOT/dist-backend"

echo "══════════════════════════════════════════════════════"
echo "  SSH Admin Backend Build"
echo "══════════════════════════════════════════════════════"

# Activate venv
if [ -f "$VENV_DIR/bin/activate" ]; then
    source "$VENV_DIR/bin/activate"
    echo "✓ Venv activated"
else
    echo "✗ Venv not found in $VENV_DIR"
    exit 1
fi

# Install PyInstaller if needed
if ! command -v pyinstaller &>/dev/null; then
    echo "→ Installing PyInstaller..."
    pip install pyinstaller
fi

# Clean previous builds
rm -rf "$OUTPUT_DIR"
rm -rf "$BACKEND_DIR/build" "$BACKEND_DIR/dist"

echo "→ Building binary..."

cd "$BACKEND_DIR"

pyinstaller sshadmin.spec \
    --distpath "$OUTPUT_DIR" \
    --workpath "$BACKEND_DIR/build" \
    --clean \
    --noconfirm

# Verify the result
if [ -f "$OUTPUT_DIR/sshadmin-backend" ]; then
    SIZE=$(du -h "$OUTPUT_DIR/sshadmin-backend" | cut -f1)
    echo ""
    echo "══════════════════════════════════════════════════════"
    echo "  ✓ Backend compiled successfully!"
    echo "  → $OUTPUT_DIR/sshadmin-backend ($SIZE)"
    echo "  → Architecture: $(file "$OUTPUT_DIR/sshadmin-backend" | grep -o 'x86_64\|arm64\|universal')"
    echo "══════════════════════════════════════════════════════"
else
    echo "✗ Build failed"
    exit 1
fi

# Clean temporary files
rm -rf "$BACKEND_DIR/build"
