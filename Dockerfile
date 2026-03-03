# ─────────────────────────────────────────────────────────
# SSH Admin — Docker Image
# Multi-stage build: Node (frontend) + Python (backend)
# ─────────────────────────────────────────────────────────

# ── Stage 1: Build the React frontend ────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --silent
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────
FROM python:3.13-slim

# Install Node.js (needed for npx prisma studio)
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        openssh-client \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Backend source
COPY backend/ ./backend/

# Frontend dist from stage 1
COPY --from=frontend-builder /build/dist ./frontend/dist

# Data directory (SQLite DB, Prisma workspaces)
RUN mkdir -p /data
ENV SSHADMIN_DB_DIR=/data

# Default port
EXPOSE 8765

# Run the backend
WORKDIR /app/backend
CMD ["python", "main.py"]
