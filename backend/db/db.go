package db

import (
	"fmt"
	"strings"
	"time"

	"github.com/wangshihong/token-usage/config"
	"github.com/wangshihong/token-usage/models"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var DB *gorm.DB

// LogDB is the connection used to read the `logs` table. It points to the
// standalone PostgreSQL database when LOG_SQL_DSN is configured, otherwise it
// falls back to the same MySQL connection as DB.
var LogDB *gorm.DB

// logDialect records the SQL dialect used by LogDB ("mysql" or "postgres"),
// so dialect-specific SQL fragments can be generated.
var logDialect string

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

	// logs table: use a standalone PostgreSQL connection when LOG_SQL_DSN is
	// configured, otherwise reuse the MySQL connection.
	if cfg.LogSQLDSN != "" {
		LogDB, err = gorm.Open(postgres.Open(cfg.LogSQLDSN), &gorm.Config{
			Logger: logger.Default.LogMode(logger.Warn),
		})
		if err != nil {
			return fmt.Errorf("failed to connect to log database: %w", err)
		}
		logSQLDB, err := LogDB.DB()
		if err != nil {
			return err
		}
		logSQLDB.SetMaxIdleConns(10)
		logSQLDB.SetMaxOpenConns(50)
		logSQLDB.SetConnMaxLifetime(time.Minute * 5)
		logDialect = "postgres"
	} else {
		LogDB = DB
		logDialect = "mysql"
	}
	return nil
}

// QueryParams holds the filter parameters for stats queries.
type QueryParams struct {
	TokenNames      []string
	Start           int64
	End             int64
	TableName       string
	ExcludeAbnormal bool
}

// --- dialect helpers ---
//
// The logs table may live in MySQL or PostgreSQL. The following helpers
// translate the few SQL fragments that differ between the two dialects.

// dateFromUnixtime returns an expression yielding the calendar date (YYYY-MM-DD)
// for a unix-timestamp column.
func dateFromUnixtime(col string) string {
	if logDialect == "postgres" {
		return "DATE(to_timestamp(" + col + ")) AS date"
	}
	return "DATE(FROM_UNIXTIME(" + col + ")) AS date"
}

// dateTimeFromUnixtime returns an expression yielding a formatted timestamp
// string "YYYY-MM-DD HH:MM:SS" for a unix-timestamp column.
func dateTimeFromUnixtime(col string) string {
	if logDialect == "postgres" {
		return "to_char(to_timestamp(" + col + "), 'YYYY-MM-DD HH24:MI:SS') AS created_at_str"
	}
	return "DATE_FORMAT(FROM_UNIXTIME(" + col + "), '%Y-%m-%d %H:%i:%s') AS created_at_str"
}

// jsonExtractText returns the text value at the given JSON path of a column.
// `path` uses MySQL JSON path syntax (e.g. "$.stream_status"); it is converted
// to the equivalent PostgreSQL `->>` accessor.
func jsonExtractText(col, path string) string {
	if logDialect == "postgres" {
		// path looks like "$.a.b" -> convert to "'a','b' ..." for #>> operator,
		// or simply the last key for ->> when single-level.
		key := strings.TrimPrefix(path, "$.")
		// only support single-level keys as used in this codebase
		return col + "::json->>" + "'" + key + "'"
	}
	return "JSON_EXTRACT(" + col + ", '" + path + "')"
}

// isStreamTrue returns the SQL condition matching a streaming request.
// PostgreSQL stores is_stream as a boolean; MySQL stores it as tinyint(1).
func isStreamTrue() string {
	if logDialect == "postgres" {
		return "is_stream = true"
	}
	return "is_stream = 1"
}

// GetAllTokenNames returns the distinct name values in the tokens table.
// The tokens table always lives in the primary MySQL database.
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
			"SUM(cache_tokens) AS cache_tokens, " +
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
		dateFromUnixtime("created_at") + ", " +
			"token_name, " +
			"model_name, " +
			"SUM(prompt_tokens) AS prompt_tokens, " +
			"SUM(completion_tokens) AS completion_tokens, " +
			"SUM(cache_tokens) AS cache_tokens, " +
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

// applyCommonFilters applies the token_names/time-range filters shared by
// all stats queries.
func applyCommonFilters(tx *gorm.DB, p QueryParams) *gorm.DB {
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

// abnormalCondition is the SQL condition identifying an abnormal request:
// a streaming request whose first-response-time (frt) is negative.
func abnormalCondition() string {
	return isStreamTrue() + " AND frt < 0"
}

func buildBaseQuery(p QueryParams) *gorm.DB {
	tx := applyCommonFilters(LogDB.Table(p.TableName).Where("type = 2"), p)
	if p.ExcludeAbnormal {
		tx = tx.Where("NOT (" + abnormalCondition() + ")")
	}
	return tx
}

// GetAbnormalLogs returns individual abnormal request records (streaming
// requests with frt < 0) matching the given filters.
func GetAbnormalLogs(p QueryParams) ([]models.AbnormalLog, error) {
	tx := applyCommonFilters(LogDB.Table(p.TableName).Where("type = 2"), p).
		Where(abnormalCondition())

	type row struct {
		TokenName        string `gorm:"column:token_name"`
		ModelName        string `gorm:"column:model_name"`
		PromptTokens     int64  `gorm:"column:prompt_tokens"`
		CompletionTokens int64  `gorm:"column:completion_tokens"`
		CacheTokens      int64  `gorm:"column:cache_tokens"`
		Quota            int64  `gorm:"column:quota"`
		CreatedAt        string `gorm:"column:created_at_str"`
		ErrorReason      string `gorm:"column:error_reason"`
	}

	var rows []row
	err := tx.Select(
		"token_name, " +
			"model_name, " +
			"prompt_tokens, " +
			"completion_tokens, " +
			"cache_tokens, " +
			"quota, " +
			dateTimeFromUnixtime("created_at") + ", " +
			"COALESCE(" + jsonExtractText("other", "$.stream_status") + ", '') AS error_reason",
	).Order("created_at DESC").Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	logs := make([]models.AbnormalLog, 0, len(rows))
	for _, r := range rows {
		logs = append(logs, models.AbnormalLog{
			TokenName:        r.TokenName,
			ModelName:        r.ModelName,
			PromptTokens:     r.PromptTokens,
			CompletionTokens: r.CompletionTokens,
			CacheTokens:      r.CacheTokens,
			TotalTokens:      r.PromptTokens + r.CompletionTokens,
			RequestCount:     1,
			Quota:            r.Quota,
			CreatedAt:        r.CreatedAt,
			ErrorReason:      r.ErrorReason,
		})
	}
	return logs, nil
}
