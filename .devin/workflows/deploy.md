---
description: Build and deploy token-usage Docker image to root@10.10.249.137
---

# Deploy Workflow

Deploy the token-usage application to the remote server `root@10.10.249.137`.

## Rules

- Image tag format: `token-usage:<version>` (e.g. `token-usage:v0.0.1`)
- Version format: `v<major>.<minor>.<patch>` (e.g. `v0.0.1`)
- **Never** use `latest` as a tag
- **Never** use `build:` in docker-compose.yml — always use pre-built images
- Each deployment increments the patch version (stored in `VERSION` file)

## Prerequisites

- SSH access to `root@10.10.249.137` (key-based, no password)
- `rsync` installed locally
- Docker and Docker Compose installed on the remote server
- `.env` file exists on the remote at `/root/token-usage/.env` with database credentials

## Steps

1. Run the deploy script:

```bash
bash deploy.sh
```

The script will:
- Read and increment the version from `VERSION`
- `rsync` project files to `/root/token-usage/` on the remote
- `docker build` the image on the remote with the versioned tag
- Update `docker-compose.yml` (both remote and local) with the new image tag
- `docker compose down && docker compose up -d` on the remote

2. Verify the deployment:

```bash
ssh root@10.10.249.137 "docker ps | grep token-usage"
```

3. If you need to bump the minor or major version, manually edit the `VERSION` file before running `deploy.sh`.

## Manual deployment (without the script)

If you need to deploy manually:

1. Increment version in `VERSION` file
2. Sync code: `rsync -avz --exclude='data/' --exclude='.git/' --exclude='node_modules/' ./ root@10.10.249.137:/root/token-usage/`
3. Build on remote: `ssh root@10.10.249.137 "cd /root/token-usage && docker build -t token-usage:<version> ."`
4. Update `docker-compose.yml` image tag to `token-usage:<version>`
5. Deploy: `ssh root@10.10.249.137 "cd /root/token-usage && docker compose down && docker compose up -d"`
