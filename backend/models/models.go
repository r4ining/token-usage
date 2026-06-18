package models

// Log mirrors the new-api logs table (read-only).
type Log struct {
	ID               int64  `gorm:"column:id"`
	UserId           int64  `gorm:"column:user_id"`
	CreatedAt        int64  `gorm:"column:created_at"`
	Type             int    `gorm:"column:type"`
	Content          string `gorm:"column:content"`
	Username         string `gorm:"column:username"`
	TokenName        string `gorm:"column:token_name"`
	ModelName        string `gorm:"column:model_name"`
	Quota            int64  `gorm:"column:quota"`
	PromptTokens     int64  `gorm:"column:prompt_tokens"`
	CompletionTokens int64  `gorm:"column:completion_tokens"`
	UseTime          int    `gorm:"column:use_time"`
	IsStream         bool   `gorm:"column:is_stream"`
	ChannelId        int    `gorm:"column:channel"`
	TokenId          int64  `gorm:"column:token_id"`
	Group            string `gorm:"column:group"`
	Other            string `gorm:"column:other"`
}

func (Log) TableName() string { return "logs" }

// Token mirrors the tokens table (read-only).
type Token struct {
	ID   int64  `gorm:"column:id"`
	Name string `gorm:"column:name"`
}

func (Token) TableName() string { return "tokens" }

// ModelStat is the result of an aggregated query per token_name + model_name.
type ModelStat struct {
	TokenName        string `json:"token_name"`
	ModelName        string `json:"model_name"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	CacheTokens      int64  `json:"cache_tokens"`
	TotalTokens      int64  `json:"total_tokens"`
	Quota            int64  `json:"quota"`
	RequestCount     int64  `json:"request_count"`
}

// DailyStat holds per-day, per-model, per-token-name aggregated data.
type DailyStat struct {
	Date             string `json:"date"`
	TokenName        string `json:"token_name"`
	ModelName        string `json:"model_name"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	CacheTokens      int64  `json:"cache_tokens"`
	TotalTokens      int64  `json:"total_tokens"`
	Quota            int64  `json:"quota"`
	RequestCount     int64  `json:"request_count"`
}

// SummaryResult is the top-level response for /api/stats/summary.
type SummaryResult struct {
	TotalPromptTokens     int64       `json:"total_prompt_tokens"`
	TotalCompletionTokens int64       `json:"total_completion_tokens"`
	TotalCacheTokens      int64       `json:"total_cache_tokens"`
	TotalTokens           int64       `json:"total_tokens"`
	TotalQuota            int64       `json:"total_quota"`
	TotalRequests         int64       `json:"total_requests"`
	ByModel               []ModelStat `json:"by_model"`
}

// PriceEntry holds user-configured pricing for a single model.
type PriceEntry struct {
	ID          string   `json:"id"`
	ModelID     string   `json:"model_id"`
	Aliases     []string `json:"aliases"`
	InputPrice  float64  `json:"input_price"`  // USD per 1M tokens
	OutputPrice float64  `json:"output_price"` // USD per 1M tokens
	CachePrice  float64  `json:"cache_price"`  // USD per 1M tokens (0 = same as input)
	Currency    string   `json:"currency"`     // "USD" or "CNY" - for frontend display
}

// PriceConfig is the persisted price configuration file.
type PriceConfig struct {
	Entries  []PriceEntry `json:"entries"`
	USDToCNY float64      `json:"usd_to_cny"`
}

// CostResult wraps a SummaryResult with computed cost fields per model.
type ModelCost struct {
	ModelStat
	CostUSD float64 `json:"cost_usd"`
	CostCNY float64 `json:"cost_cny"`
}

type DailyCost struct {
	DailyStat
	CostUSD float64 `json:"cost_usd"`
	CostCNY float64 `json:"cost_cny"`
}
