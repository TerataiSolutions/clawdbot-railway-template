#!/bin/bash
set -e

echo "Starting Fathom webhook server on port 4242..."
node scripts/fathom_webhook.js &
WEBHOOK_PID=$!

sleep 2

echo "Starting main server..."
node src/server.js &
MAIN_PID=$!

wait $WEBHOOK_PID $MAIN_PID
