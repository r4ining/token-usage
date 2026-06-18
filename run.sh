#!/bin/bash

# set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== 构建前端 ==="
cd frontend
npm run build
cd ..

echo "=== 杀死 8080 端口进程 ==="
kill -9 $(lsof -t -i :8080)

echo "=== 启动后端 ==="
cd backend
DB_HOST=10.10.251.102 \
DB_PORT=32002 \
DB_USER=new_api_readonly \
DB_PASSWORD=qf55K0Qus2lUGmJLFF \
DB_NAME=new_api \
DATA_DIR=${SCRIPT_DIR}/data \
go run .
