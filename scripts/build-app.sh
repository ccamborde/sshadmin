#!/bin/bash
# ─────────────────────────────────────────────────────────
# Full Electron build for SSH Admin on macOS
# Usage:
#   ./scripts/build-app.sh          # Build for current arch
#   ./scripts/build-app.sh x64      # Build Intel only
#   ./scripts/build-app.sh arm64    # Build Apple Silicon only
#   ./scripts/build-app.sh universal # Build universal (both)
# ─────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARCH="${1:-$(uname -m)}"

# Normalize architecture
case "$ARCH" in
    x86_64|x64|intel)  ARCH_FLAG="--x64" ; ARCH_LABEL="Intel (x64)" ;;
    arm64|aarch64)     ARCH_FLAG="--arm64" ; ARCH_LABEL="Apple Silicon (arm64)" ;;
    universal)         ARCH_FLAG="--universal" ; ARCH_LABEL="Universal (x64 + arm64)" ;;
    *)                 ARCH_FLAG="" ; ARCH_LABEL="Current architecture" ;;
esac

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║     SSH Admin - macOS Build ($ARCH_LABEL)           ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

cd "$PROJECT_ROOT"

# ── Step 1: Build the frontend ───────────────────────────
echo "┌─ Step 1/4: Building React frontend..."
cd "$PROJECT_ROOT/frontend"
npm run build
echo "└─ ✓ Frontend compiled"
echo ""

# ── Step 2: Build the backend ────────────────────────────
echo "┌─ Step 2/4: Building Python backend..."
cd "$PROJECT_ROOT"
bash scripts/build-backend.sh
echo "└─ ✓ Backend compiled"
echo ""

# ── Step 3: macOS icon ───────────────────────────────────
echo "┌─ Step 3/4: Generating icon..."
if [ -f "build/icon.svg" ] && ! [ -f "build/icon.icns" ]; then
    # Try to create the icon with sips (native macOS tool)
    if command -v sips &>/dev/null; then
        # Create a temporary PNG from SVG if possible
        if command -v rsvg-convert &>/dev/null; then
            rsvg-convert -w 1024 -h 1024 build/icon.svg > build/icon.png
        elif command -v convert &>/dev/null; then
            convert -background none -size 1024x1024 build/icon.svg build/icon.png
        else
            echo "  ⚠ Unable to convert SVG. The app will use the default icon."
        fi
        
        if [ -f "build/icon.png" ]; then
            # Create the .iconset
            mkdir -p build/icon.iconset
            for size in 16 32 64 128 256 512; do
                sips -z $size $size build/icon.png --out "build/icon.iconset/icon_${size}x${size}.png" >/dev/null 2>&1
                double=$((size * 2))
                sips -z $double $double build/icon.png --out "build/icon.iconset/icon_${size}x${size}@2x.png" >/dev/null 2>&1
            done
            iconutil -c icns build/icon.iconset -o build/icon.icns 2>/dev/null || true
            rm -rf build/icon.iconset build/icon.png
        fi
    fi
fi
if [ -f "build/icon.icns" ]; then
    echo "└─ ✓ Icon generated"
else
    echo "└─ ⚠ No .icns icon — the app will use the default icon"
fi
echo ""

# ── Step 4: Package Electron ─────────────────────────────
echo "┌─ Step 4/4: Packaging Electron ($ARCH_LABEL)..."

# Install Electron dependencies if needed
if [ ! -d "node_modules/electron" ]; then
    echo "  → Installing Electron dependencies..."
    npm install
fi

npx electron-builder --mac $ARCH_FLAG

echo "└─ ✓ Application packaged"
echo ""

# ── Result ────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✓ Build complete!                                  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Output files in: $PROJECT_ROOT/release/"
ls -lah "$PROJECT_ROOT/release/"*.dmg 2>/dev/null || ls -lah "$PROJECT_ROOT/release/" 2>/dev/null
echo ""
