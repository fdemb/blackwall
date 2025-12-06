#!/bin/bash

mv src/routes src/routes.old
PID=$(bun run dev &)
sleep 5
mv src/routes.old src/routes
pkill -f "$PID"