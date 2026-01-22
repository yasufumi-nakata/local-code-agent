#!/bin/bash

# Kill background processes on exit
trap "trap - SIGTERM && kill -- -$$" SIGINT SIGTERM EXIT

echo "Starting Local Code Agent..."
echo "Ensure LM Studio server is running at http://localhost:1234/v1"

# Start Backend
echo "Starting Backend on port 8000..."
source venv/bin/activate
python3 -m uvicorn backend.main:app --reload --port 8000 &
BACKEND_PID=$!

# Wait for backend to start (simple sleep)
sleep 2

# Start Frontend
echo "Starting Frontend..."
cd frontend
npm run dev &
FRONTEND_PID=$!

echo "App is running!"
echo "Backend: http://localhost:8000"
echo "Frontend: http://localhost:5173"
echo "Press Ctrl+C to stop."

wait
