package db

import (
	"fmt"
	"strings"
	"time"

	"github.com/wangshihong/token-usage/config"
	"github.com/wangshihong/token-usage/models"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var DB *gorm.DB

func Init(cfg *config.Config) error {
	var err error
	DB, err = gorm.Open(mysql.Open(cfg.DSN()), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}

	sqlDB, err := DB.DB()
	if err != nil {
		return err
	}
	sqlDB.SetMaxIdleConns(10)
	sqlDB.SetMaxOpenConns(50)
	sqlDB.SetConnMaxLifetime(time.Minute * 5)
	return nil
}

// QueryParams holds the filter parameters for stats queries.
type QueryParams struct {
	TokenNames []string
	Start      int64
	End        int64
	TableName  string
}

// GetAllTokenNames returns the distinct name values in the tokens table.
func GetAllTokenNames(tableName string) ([]string, error) {
	var names []string
	err := DB.Table("tokens").
		Select("DISTINCT name").
		Where("name != ''").
		Order("name").
		Pluck("name", &names).Error
	return names, err
}

// GetSummary returns aggregated stats grouped by token_name + model_name.
func GetSummary(p QueryParams) ([]models.ModelStat, error) {
	tx := buildBaseQuery(p)

	type row struct {
		TokenName        string  `gorm:"column:token_name"`
		ModelName        string  `gorm:"column:model_name"`
		PromptTokens     int64   `gorm:"column:prompt_tokens"`
		CompletionTokens int64   `gorm:"column:completion_tokens"`
		CacheTokens      float64 `gorm:"column:cache_tokens"`
		Quota            int64   `gorm:"column:quota"`
		RequestCount     int64   `gorm:"column:request_count"`
	}

	var rows []row
	err := tx.Select(
		"token_name, " +
			"model_name, " +
			"SUM(prompt_tokens) AS prompt_tokens, " +
			"SUM(completion_tokens) AS completion_tokens, " +
			"SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(other, '$.cache_tokens')) AS UNSIGNED)) AS cache_tokens, " +
			"SUM(quota) AS quota, " +
			"COUNT(*) AS request_count",
	).Group("token_name, model_name").
		Order("token_name, prompt_tokens DESC").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	stats := make([]models.ModelStat, 0, len(rows))
	for _, r := range rows {
		ct := int64(r.CacheTokens)
		stats = append(stats, models.ModelStat{
			TokenName:        r.TokenName,
			ModelName:        r.ModelName,
			PromptTokens:     r.PromptTokens,
			CompletionTokens: r.CompletionTokens,
			CacheTokens:      ct,
			TotalTokens:      r.PromptTokens + r.CompletionTokens,
			Quota:            r.Quota,
			RequestCount:     r.RequestCount,
		})
	}
	return stats, nil
}

// GetDailyStats returns aggregated stats grouped by date + token_name + model_name.
func GetDailyStats(p QueryParams) ([]models.DailyStat, error) {
	tx := buildBaseQuery(p)

	type row struct {
		Date             string  `gorm:"column:date"`
		TokenName        string  `gorm:"column:token_name"`
		ModelName        string  `gorm:"column:model_name"`
		PromptTokens     int64   `gorm:"column:prompt_tokens"`
		CompletionTokens int64   `gorm:"column:completion_tokens"`
		CacheTokens      float64 `gorm:"column:cache_tokens"`
		Quota            int64   `gorm:"column:quota"`
		RequestCount     int64   `gorm:"column:request_count"`
	}

	var rows []row
	err := tx.Select(
		"DATE(FROM_UNIXTIME(created_at)) AS date, " +
			"token_name, " +
			"model_name, " +
			"SUM(prompt_tokens) AS prompt_tokens, " +
			"SUM(completion_tokens) AS completion_tokens, " +
			"SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(other, '$.cache_tokens')) AS UNSIGNED)) AS cache_tokens, " +
			"SUM(quota) AS quota, " +
			"COUNT(*) AS request_count",
	).Group("date, token_name, model_name").
		Order("date DESC, token_name, model_name").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	stats := make([]models.DailyStat, 0, len(rows))
	for _, r := range rows {
		ct := int64(r.CacheTokens)
		stats = append(stats, models.DailyStat{
			Date:             r.Date,
			TokenName:        r.TokenName,
			ModelName:        r.ModelName,
			PromptTokens:     r.PromptTokens,
			CompletionTokens: r.CompletionTokens,
			CacheTokens:      ct,
			TotalTokens:      r.PromptTokens + r.CompletionTokens,
			Quota:            r.Quota,
			RequestCount:     r.RequestCount,
		})
	}
	return stats, nil
}

func buildBaseQuery(p QueryParams) *gorm.DB {
	tx := DB.Table(p.TableName).Where("type = 2")

	if len(p.TokenNames) > 0 {
		placeholders := make([]string, len(p.TokenNames))
		args := make([]interface{}, len(p.TokenNames))
		for i, n := range p.TokenNames {
			placeholders[i] = "?"
			args[i] = n
		}
		tx = tx.Where("token_name IN ("+strings.Join(placeholders, ",")+")", args...)
	}
	if p.Start > 0 {
		tx = tx.Where("created_at >= ?", p.Start)
	}
	if p.End > 0 {
		tx = tx.Where("created_at < ?", p.End)
	}
	return tx
}
