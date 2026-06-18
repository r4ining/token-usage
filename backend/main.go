package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"strings"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/wangshihong/token-usage/config"
	"github.com/wangshihong/token-usage/db"
	"github.com/wangshihong/token-usage/handlers"
)

//go:embed static/dist
var staticFiles embed.FS

func main() {
	cfg := config.Load()

	if err := db.Init(cfg); err != nil {
		log.Fatalf("database init failed: %v", err)
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.Default()

	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept"},
		AllowCredentials: false,
	}))

	handlers.Register(r, cfg)

	// Serve SPA static files from embedded FS.
	distFS, err := fs.Sub(staticFiles, "static/dist")
	if err != nil {
		log.Fatalf("failed to sub static fs: %v", err)
	}

	r.NoRoute(func(c *gin.Context) {
		path := c.Request.URL.Path
		// API routes should already be handled; 404 them directly.
		if strings.HasPrefix(path, "/api/") {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		// For SPA: try to serve the file, fall back to index.html.
		fileServer := http.FileServer(http.FS(distFS))
		_, err := distFS.Open(strings.TrimPrefix(path, "/"))
		if err != nil {
			// Serve index.html for SPA routing.
			data, err2 := fs.ReadFile(distFS, "index.html")
			if err2 != nil {
				c.Status(http.StatusNotFound)
				return
			}
			c.Data(http.StatusOK, "text/html; charset=utf-8", data)
			return
		}
		fileServer.ServeHTTP(c.Writer, c.Request)
	})

	log.Printf("Token Usage Platform listening on :%s", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatalf("failed to start server: %v", err)
	}
}
