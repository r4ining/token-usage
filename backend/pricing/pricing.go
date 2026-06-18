package pricing

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/wangshihong/token-usage/models"
)

const defaultUSDToCNY = 7.25

func defaultConfig() *models.PriceConfig {
	return &models.PriceConfig{
		Entries: []models.PriceEntry{
			{
				ID:          "glm-5.1",
				ModelID:     "glm-5.1",
				Aliases:     []string{},
				InputPrice:  8.0000 / defaultUSDToCNY,  // CNY to USD
				OutputPrice: 28.0000 / defaultUSDToCNY, // CNY to USD
				CachePrice:  0,
			},
			{
				ID:          "minimax-m2.7",
				ModelID:     "minimax-m2.7",
				Aliases:     []string{},
				InputPrice:  2.1970 / defaultUSDToCNY, // CNY to USD
				OutputPrice: 8.7820 / defaultUSDToCNY, // CNY to USD
				CachePrice:  0,
			},
		},
		USDToCNY: defaultUSDToCNY,
	}
}

func configPath(dataDir string) string {
	return filepath.Join(dataDir, "prices.json")
}

// Load reads the price configuration from disk; returns defaults if not found.
func Load(dataDir string) (*models.PriceConfig, error) {
	data, err := os.ReadFile(configPath(dataDir))
	if err != nil {
		if os.IsNotExist(err) {
			return defaultConfig(), nil
		}
		return nil, err
	}
	var cfg models.PriceConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.USDToCNY == 0 {
		cfg.USDToCNY = defaultUSDToCNY
	}
	if cfg.Entries == nil {
		cfg.Entries = []models.PriceEntry{}
	}
	return &cfg, nil
}

// round6 rounds a float64 to 6 decimal places to eliminate floating-point noise.
func round6(v float64) float64 {
	return math.Round(v*1e6) / 1e6
}

// Save persists the price configuration to disk.
func Save(dataDir string, cfg *models.PriceConfig) error {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return err
	}
	// Normalise prices to 6 dp to prevent floating-point noise (e.g. 7.999999999999999)
	for i := range cfg.Entries {
		e := &cfg.Entries[i]
		e.InputPrice = round6(e.InputPrice)
		e.OutputPrice = round6(e.OutputPrice)
		e.CachePrice = round6(e.CachePrice)
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(dataDir), data, 0644)
}

// FindEntry finds the price entry matching a model name (exact or alias).
func FindEntry(cfg *models.PriceConfig, modelName string) *models.PriceEntry {
	lower := strings.ToLower(modelName)
	for i := range cfg.Entries {
		e := &cfg.Entries[i]
		if strings.ToLower(e.ModelID) == lower {
			return e
		}
		for _, alias := range e.Aliases {
			if strings.Contains(lower, strings.ToLower(alias)) || strings.ToLower(alias) == lower {
				return e
			}
		}
	}
	return nil
}

// toUSD converts a price to USD. If the entry's currency is CNY, divides by usdToCNY.
// Empty/unknown currency is treated as USD.
func toUSD(price float64, currency string, usdToCNY float64) float64 {
	if strings.EqualFold(currency, "CNY") && usdToCNY > 0 {
		return price / usdToCNY
	}
	return price
}

// CalcCost computes USD cost for a model stat row.
// Returns 0 if no price entry found.
// Prices in the entry are normalised to USD via entry.Currency and usdToCNY before use.
//
// useCachePrice controls how cache read tokens are billed:
//   - true  (recommended for OpenAI-format models): prompt_tokens in new-api includes cache_tokens,
//     so we subtract cache_tokens from prompt to avoid double-counting, then charge cache_tokens at
//     cachePrice (falls back to inputPrice when cachePrice == 0).
//   - false: ignore cache token distinction; all prompt_tokens are billed at inputPrice.
func CalcCost(entry *models.PriceEntry, usdToCNY float64, promptTokens, completionTokens, cacheTokens int64, useCachePrice bool) float64 {
	if entry == nil {
		return 0
	}
	inputPrice := toUSD(entry.InputPrice, entry.Currency, usdToCNY)
	outputPrice := toUSD(entry.OutputPrice, entry.Currency, usdToCNY)
	outputCost := float64(completionTokens) * outputPrice / 1_000_000

	if useCachePrice && cacheTokens > 0 {
		cachePrice := toUSD(entry.CachePrice, entry.Currency, usdToCNY)
		if cachePrice == 0 {
			cachePrice = inputPrice
		}
		nonCacheTokens := promptTokens - cacheTokens
		if nonCacheTokens < 0 {
			nonCacheTokens = 0
		}
		inputCost := float64(nonCacheTokens) * inputPrice / 1_000_000
		cacheCost := float64(cacheTokens) * cachePrice / 1_000_000
		return inputCost + outputCost + cacheCost
	}

	inputCost := float64(promptTokens) * inputPrice / 1_000_000
	return inputCost + outputCost
}
