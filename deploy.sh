#!/bin/bash
set -e

REMOTE="root@10.10.249.137"
REMOTE_DIR="/root/token-usage"
VERSION_FILE="VERSION"

# Read current version or initialize
if [ ! -f "$VERSION_FILE" ]; then
  VERSION="v0.0.1"
else
  CURRENT=$(cat "$VERSION_FILE" | tr -d '[:space:]')
  major=$(echo "$CURRENT" | sed 's/v//' | cut -d. -f1)
  minor=$(echo "$CURRENT" | sed 's/v//' | cut -d. -f2)
  patch=$(echo "$CURRENT" | sed 's/v//' | cut -d. -f3)
  patch=$((patch + 1))
  VERSION="v${major}.${minor}.${patch}"
fi

echo "$VERSION" > "$VERSION_FILE"
IMAGE_TAG="token-usage:${VERSION}"
echo "=== Deploying $IMAGE_TAG ==="

# Sync project files to remote (exclude build artifacts and local data)
echo "=== Syncing files to $REMOTE:$REMOTE_DIR ==="
rsync -avz --delete \
  --exclude='data/' \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='frontend/node_modules/' \
  --exclude='frontend/dist/' \
  --exclude='backend/token-usage' \
  --exclude='backend/static/dist/' \
  --exclude='.env' \
  ./ "$REMOTE:$REMOTE_DIR/"

# Build Docker image on remote
echo "=== Building image on remote ==="
ssh "$REMOTE" "cd $REMOTE_DIR && docker build -t $IMAGE_TAG ."

# Update docker-compose.yml on remote with the new tag
ssh "$REMOTE" "cd $REMOTE_DIR && sed -i 's|image: token-usage:.*|image: $IMAGE_TAG|' docker-compose.yml"

# Restart the service on remote
echo "=== Restarting service ==="
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose down && docker compose up -d"

# Update local docker-compose.yml (macOS sed)
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|image: token-usage:.*|image: $IMAGE_TAG|" docker-compose.yml
else
  sed -i "s|image: token-usage:.*|image: $IMAGE_TAG|" docker-compose.yml
fi

echo "=== Deployed $IMAGE_TAG successfully ==="
