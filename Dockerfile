# Stage 1: Build frontend
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build backend (with embedded frontend)
FROM golang:1.22-alpine AS backend
WORKDIR /app/backend
# Copy go.mod/go.sum first for better layer caching
COPY backend/go.mod backend/go.sum ./
RUN go mod download
# Copy backend source
COPY backend/ ./
# Copy the built frontend into the embed path
COPY --from=frontend /app/backend/static/dist ./static/dist
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/token-usage .

# Stage 3: Final minimal image
FROM alpine:3.19
RUN apk add --no-cache tzdata ca-certificates
ENV TZ=Asia/Shanghai
WORKDIR /app
COPY --from=backend /app/token-usage ./token-usage
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/app/token-usage"]
