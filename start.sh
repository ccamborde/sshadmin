#!/bin/bash
# SSH Admin - Docker Monitor
# Startup script

set -e

echo "🚀 Starting SSH Admin - Docker Monitor"
echo ""

# Backend
echo "📦 Installing backend dependencies..."
cd backend
pip install -r requirements.txt -q
echo "✅ Backend ready"
echo ""

# Frontend
echo "📦 Installing frontend dependencies..."
cd ../frontend
npm install --silent
echo "✅ Frontend ready"
echo ""

# Start
echo "🔧 Starting backend (port 8765)..."
cd ../backend
python main.py &
BACKEND_PID=$!

echo "🎨 Starting frontend (port 3000)..."
cd ../frontend
npm run dev &
FRONTEND_PID=$!

echo ""
echo "✨ Application started!"
echo "   Frontend: http://localhost:3000"
echo "   Backend:  http://localhost:8765"
echo "   API Docs: http://localhost:8765/docs"
echo ""
echo "Press Ctrl+C to stop"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
