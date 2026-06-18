package handlers

import (
	"bytes"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/wangshihong/token-usage/config"
	"github.com/wangshihong/token-usage/db"
	"github.com/wangshihong/token-usage/models"
	"github.com/wangshihong/token-usage/pricing"
	"github.com/xuri/excelize/v2"
)

func Register(r *gin.Engine, cfg *config.Config) {
	api := r.Group("/api")

	api.GET("/tokens", func(c *gin.Context) { getTokens(c, cfg) })
	api.GET("/stats/summary", func(c *gin.Context) { getSummary(c, cfg) })
	api.GET("/stats/daily", func(c *gin.Context) { getDaily(c, cfg) })
	api.GET("/export", func(c *gin.Context) { exportExcel(c, cfg) })
	api.GET("/prices", func(c *gin.Context) { getPrices(c, cfg) })
	api.POST("/prices", func(c *gin.Context) { savePrices(c, cfg) })
}

// --- helpers ---

var shanghaiLoc = time.FixedZone("CST", 8*3600)

func parseQueryParams(c *gin.Context, tableName string) db.QueryParams {
	tokenNamesRaw := c.Query("token_names")
	var tokenNames []string
	for _, t := range strings.Split(tokenNamesRaw, ",") {
		t = strings.TrimSpace(t)
		if t != "" {
			tokenNames = append(tokenNames, t)
		}
	}

	start, _ := strconv.ParseInt(c.Query("start"), 10, 64)
	end, _ := strconv.ParseInt(c.Query("end"), 10, 64)

	// granularity shortcuts
	granularity := c.Query("granularity")
	now := time.Now().In(shanghaiLoc)
	switch granularity {
	case "today":
		y, m, d := now.Date()
		start = time.Date(y, m, d, 0, 0, 0, 0, now.Location()).Unix()
		end = time.Date(y, m, d+1, 0, 0, 0, 0, now.Location()).Unix()
	case "week":
		weekday := int(now.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		monday := now.AddDate(0, 0, -(weekday - 1))
		y, m, d := monday.Date()
		start = time.Date(y, m, d, 0, 0, 0, 0, now.Location()).Unix()
		end = now.Unix()
	case "month":
		y, m, _ := now.Date()
		start = time.Date(y, m, 1, 0, 0, 0, 0, now.Location()).Unix()
		end = now.Unix()
	case "last30":
		start = now.AddDate(0, 0, -30).Unix()
		end = now.Unix()
	}

	return db.QueryParams{
		TokenNames: tokenNames,
		Start:      start,
		End:        end,
		TableName:  tableName,
	}
}

func errJSON(c *gin.Context, code int, msg string) {
	c.JSON(code, gin.H{"error": msg})
}

// --- handlers ---

func getTokens(c *gin.Context, cfg *config.Config) {
	names, err := db.GetAllTokenNames(cfg.DBTable)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": names})
}

func getSummary(c *gin.Context, cfg *config.Config) {
	p := parseQueryParams(c, cfg.DBTable)
	stats, err := db.GetSummary(p)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}

	useCachePrice := c.Query("use_cache_price") == "1"
	pc, _ := pricing.Load(cfg.DataDir)
	withCost := enrichModelStats(stats, pc, useCachePrice)

	var total models.SummaryResult
	for _, s := range stats {
		total.TotalPromptTokens += s.PromptTokens
		total.TotalCompletionTokens += s.CompletionTokens
		total.TotalCacheTokens += s.CacheTokens
		total.TotalTokens += s.TotalTokens
		total.TotalQuota += s.Quota
		total.TotalRequests += s.RequestCount
	}
	total.ByModel = stats

	c.JSON(http.StatusOK, gin.H{
		"summary":  total,
		"by_model": withCost,
	})
}

func getDaily(c *gin.Context, cfg *config.Config) {
	p := parseQueryParams(c, cfg.DBTable)
	stats, err := db.GetDailyStats(p)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}

	useCachePrice := c.Query("use_cache_price") == "1"
	pc, _ := pricing.Load(cfg.DataDir)
	withCost := enrichDailyStats(stats, pc, useCachePrice)

	c.JSON(http.StatusOK, gin.H{"data": withCost})
}

func getPrices(c *gin.Context, cfg *config.Config) {
	pc, err := pricing.Load(cfg.DataDir)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, pc)
}

func savePrices(c *gin.Context, cfg *config.Config) {
	var pc models.PriceConfig
	if err := c.ShouldBindJSON(&pc); err != nil {
		errJSON(c, http.StatusBadRequest, err.Error())
		return
	}

	if err := pricing.Save(cfg.DataDir, &pc); err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func fmtTokensExcel(n int64, humanFriendly bool) interface{} {
	if !humanFriendly {
		return n
	}
	if n >= 1_000_000 {
		return fmt.Sprintf("%.3fM", float64(n)/1_000_000)
	}
	if n >= 1_000 {
		return fmt.Sprintf("%.3fK", float64(n)/1_000)
	}
	return n
}

func formatTimeRange(start, end int64) string {
	if start == 0 && end == 0 {
		return "全部时间"
	}
	startStr := time.Unix(start, 0).Format("2006-01-02 15:04:05")
	endStr := time.Unix(end, 0).Format("2006-01-02 15:04:05")
	return startStr + " ~ " + endStr
}

func exportExcel(c *gin.Context, cfg *config.Config) {
	p := parseQueryParams(c, cfg.DBTable)
	pc, _ := pricing.Load(cfg.DataDir)
	humanFriendly := c.Query("human_friendly") == "1"
	useCachePrice := c.Query("use_cache_price") == "1"

	daily, err := db.GetDailyStats(p)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}
	summary, err := db.GetSummary(p)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}

	f := excelize.NewFile()
	defer f.Close()

	timeRange := formatTimeRange(p.Start, p.End)
	writeSummarySheet(f, summary, pc, timeRange, humanFriendly, useCachePrice)
	writeDailySheet(f, daily, pc, timeRange, humanFriendly, useCachePrice)

	// remove default Sheet1
	f.DeleteSheet("Sheet1")

	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}

	filename := fmt.Sprintf("token-usage-%s.xlsx", time.Now().Format("20060102-150405"))
	c.Header("Content-Disposition", "attachment; filename="+filename)
	c.Header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buf.Bytes())
}

// --- enrichment helpers ---

func enrichModelStats(stats []models.ModelStat, pc *models.PriceConfig, useCachePrice bool) []models.ModelCost {
	result := make([]models.ModelCost, 0, len(stats))
	for _, s := range stats {
		entry := pricing.FindEntry(pc, s.ModelName)
		costUSD := pricing.CalcCost(entry, pc.USDToCNY, s.PromptTokens, s.CompletionTokens, s.CacheTokens, useCachePrice)
		result = append(result, models.ModelCost{
			ModelStat: s,
			CostUSD:   costUSD,
			CostCNY:   costUSD * pc.USDToCNY,
		})
	}
	return result
}

func enrichDailyStats(stats []models.DailyStat, pc *models.PriceConfig, useCachePrice bool) []models.DailyCost {
	result := make([]models.DailyCost, 0, len(stats))
	for _, s := range stats {
		entry := pricing.FindEntry(pc, s.ModelName)
		costUSD := pricing.CalcCost(entry, pc.USDToCNY, s.PromptTokens, s.CompletionTokens, s.CacheTokens, useCachePrice)
		result = append(result, models.DailyCost{
			DailyStat: s,
			CostUSD:   costUSD,
			CostCNY:   costUSD * pc.USDToCNY,
		})
	}
	return result
}

// --- excel writers ---

func writeSummarySheet(f *excelize.File, stats []models.ModelStat, pc *models.PriceConfig, timeRange string, humanFriendly bool, useCachePrice bool) {
	sheet := "模型汇总"
	f.NewSheet(sheet)

	// Sort stats by token_name to ensure proper grouping
	sort.Slice(stats, func(i, j int) bool {
		return stats[i].TokenName < stats[j].TokenName
	})

	// Column count (9 columns: A-I)
	colCount := 9
	lastCol, _ := excelize.ColumnNumberToName(colCount)

	// Create combined border+fill style for subtotal rows
	subtotalStyle, _ := f.NewStyle(&excelize.Style{
		Fill:   excelize.Fill{Type: "pattern", Color: []string{"#E3F2FD"}, Pattern: 1},
		Border: []excelize.Border{{Type: "left", Color: "000000", Style: 1}, {Type: "top", Color: "000000", Style: 1}, {Type: "right", Color: "000000", Style: 1}, {Type: "bottom", Color: "000000", Style: 1}},
	})

	// Create border-only style for regular cells
	borderStyle, _ := f.NewStyle(&excelize.Style{
		Border: []excelize.Border{{Type: "left", Color: "000000", Style: 1}, {Type: "top", Color: "000000", Style: 1}, {Type: "right", Color: "000000", Style: 1}, {Type: "bottom", Color: "000000", Style: 1}},
	})

	// Time range row with merged cells
	f.SetCellValue(sheet, "A1", "查询时间区间："+timeRange)
	f.MergeCell(sheet, "A1", lastCol+"1")

	// Headers
	headers := []string{"Key名称", "模型", "请求次数", "输入Tokens", "缓存读Tokens", "输出Tokens", "总Tokens", "费用(USD)", "费用(CNY)"}
	for i, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 2)
		f.SetCellValue(sheet, cell, h)
	}
	// Apply border to header row
	f.SetCellStyle(sheet, "A2", lastCol+"2", borderStyle)

	// Group by token_name and write with subtotals
	currentRow := 3
	grandTotal := struct {
		Requests   int64
		Prompt     int64
		Cache      int64
		Completion int64
		Total      int64
		CostUSD    float64
		CostCNY    float64
	}{}

	for i := 0; i < len(stats); {
		tokenName := stats[i].TokenName
		tokenStartRow := currentRow
		subTotal := struct {
			Requests   int64
			Prompt     int64
			Cache      int64
			Completion int64
			Total      int64
			CostUSD    float64
			CostCNY    float64
		}{}

		// Write all rows for this token
		for i < len(stats) && stats[i].TokenName == tokenName {
			s := stats[i]
			entry := pricing.FindEntry(pc, s.ModelName)
			costUSD := pricing.CalcCost(entry, pc.USDToCNY, s.PromptTokens, s.CompletionTokens, s.CacheTokens, useCachePrice)
			costCNY := costUSD * pc.USDToCNY

			vals := []interface{}{
				s.TokenName, s.ModelName, s.RequestCount,
				fmtTokensExcel(s.PromptTokens, humanFriendly),
				fmtTokensExcel(s.CacheTokens, humanFriendly),
				fmtTokensExcel(s.CompletionTokens, humanFriendly),
				fmtTokensExcel(s.TotalTokens, humanFriendly),
				fmt.Sprintf("%.6f", costUSD),
				fmt.Sprintf("%.4f", costCNY),
			}
			for col, v := range vals {
				cell, _ := excelize.CoordinatesToCellName(col+1, currentRow)
				f.SetCellValue(sheet, cell, v)
			}
			// Apply border style to data row
			rowStart, _ := excelize.CoordinatesToCellName(1, currentRow)
			rowEnd, _ := excelize.CoordinatesToCellName(colCount, currentRow)
			f.SetCellStyle(sheet, rowStart, rowEnd, borderStyle)

			subTotal.Requests += s.RequestCount
			subTotal.Prompt += s.PromptTokens
			subTotal.Cache += s.CacheTokens
			subTotal.Completion += s.CompletionTokens
			subTotal.Total += s.TotalTokens
			subTotal.CostUSD += costUSD
			subTotal.CostCNY += costCNY

			i++
			currentRow++
		}
		tokenEndRow := currentRow - 1

		// Merge Key名称 cells for this token group (column A)
		if tokenStartRow < tokenEndRow {
			f.MergeCell(sheet, fmt.Sprintf("A%d", tokenStartRow), fmt.Sprintf("A%d", tokenEndRow))
		}

		// Subtotal row with light blue background
		subTotalVals := []interface{}{"", "小计", subTotal.Requests,
			fmtTokensExcel(subTotal.Prompt, humanFriendly),
			fmtTokensExcel(subTotal.Cache, humanFriendly),
			fmtTokensExcel(subTotal.Completion, humanFriendly),
			fmtTokensExcel(subTotal.Total, humanFriendly),
			fmt.Sprintf("%.6f", subTotal.CostUSD),
			fmt.Sprintf("%.4f", subTotal.CostCNY),
		}
		for col, v := range subTotalVals {
			cell, _ := excelize.CoordinatesToCellName(col+1, currentRow)
			f.SetCellValue(sheet, cell, v)
		}
		// Apply combined border+fill style to subtotal row
		subtotalStart, _ := excelize.CoordinatesToCellName(1, currentRow)
		subtotalEnd, _ := excelize.CoordinatesToCellName(colCount, currentRow)
		f.SetCellStyle(sheet, subtotalStart, subtotalEnd, subtotalStyle)
		currentRow++

		// Accumulate grand total
		grandTotal.Requests += subTotal.Requests
		grandTotal.Prompt += subTotal.Prompt
		grandTotal.Cache += subTotal.Cache
		grandTotal.Completion += subTotal.Completion
		grandTotal.Total += subTotal.Total
		grandTotal.CostUSD += subTotal.CostUSD
		grandTotal.CostCNY += subTotal.CostCNY
	}

	// Grand total row
	grandTotalVals := []interface{}{"", "合计", grandTotal.Requests,
		fmtTokensExcel(grandTotal.Prompt, humanFriendly),
		fmtTokensExcel(grandTotal.Cache, humanFriendly),
		fmtTokensExcel(grandTotal.Completion, humanFriendly),
		fmtTokensExcel(grandTotal.Total, humanFriendly),
		fmt.Sprintf("%.6f", grandTotal.CostUSD),
		fmt.Sprintf("%.4f", grandTotal.CostCNY),
	}
	for col, v := range grandTotalVals {
		cell, _ := excelize.CoordinatesToCellName(col+1, currentRow)
		f.SetCellValue(sheet, cell, v)
	}
	// Apply border style to grand total row
	grandTotalStart, _ := excelize.CoordinatesToCellName(1, currentRow)
	grandTotalEnd, _ := excelize.CoordinatesToCellName(colCount, currentRow)
	f.SetCellStyle(sheet, grandTotalStart, grandTotalEnd, borderStyle)
}

func writeDailySheet(f *excelize.File, stats []models.DailyStat, pc *models.PriceConfig, timeRange string, humanFriendly bool, useCachePrice bool) {
	sheet := "每日明细"
	f.NewSheet(sheet)

	// Sort stats by token_name to ensure proper grouping
	sort.Slice(stats, func(i, j int) bool {
		return stats[i].TokenName < stats[j].TokenName
	})

	// Column count (10 columns: A-J)
	colCount := 10
	lastCol, _ := excelize.ColumnNumberToName(colCount)

	// Create combined border+fill style for subtotal rows
	subtotalStyle, _ := f.NewStyle(&excelize.Style{
		Fill:   excelize.Fill{Type: "pattern", Color: []string{"#E3F2FD"}, Pattern: 1},
		Border: []excelize.Border{{Type: "left", Color: "000000", Style: 1}, {Type: "top", Color: "000000", Style: 1}, {Type: "right", Color: "000000", Style: 1}, {Type: "bottom", Color: "000000", Style: 1}},
	})

	// Create border-only style for regular cells
	borderStyle, _ := f.NewStyle(&excelize.Style{
		Border: []excelize.Border{{Type: "left", Color: "000000", Style: 1}, {Type: "top", Color: "000000", Style: 1}, {Type: "right", Color: "000000", Style: 1}, {Type: "bottom", Color: "000000", Style: 1}},
	})

	// Time range row with merged cells
	f.SetCellValue(sheet, "A1", "查询时间区间："+timeRange)
	f.MergeCell(sheet, "A1", lastCol+"1")

	// Headers
	headers := []string{"日期", "Key名称", "模型", "请求次数", "输入Tokens", "缓存读Tokens", "输出Tokens", "总Tokens", "费用(USD)", "费用(CNY)"}
	for i, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 2)
		f.SetCellValue(sheet, cell, h)
	}
	// Apply border to header row
	f.SetCellStyle(sheet, "A2", lastCol+"2", borderStyle)

	// Group by token_name and write with subtotals
	currentRow := 3
	grandTotal := struct {
		Requests   int64
		Prompt     int64
		Cache      int64
		Completion int64
		Total      int64
		CostUSD    float64
		CostCNY    float64
	}{}

	for i := 0; i < len(stats); {
		tokenName := stats[i].TokenName
		tokenStartRow := currentRow
		subTotal := struct {
			Requests   int64
			Prompt     int64
			Cache      int64
			Completion int64
			Total      int64
			CostUSD    float64
			CostCNY    float64
		}{}

		// Write all rows for this token
		for i < len(stats) && stats[i].TokenName == tokenName {
			s := stats[i]
			entry := pricing.FindEntry(pc, s.ModelName)
			costUSD := pricing.CalcCost(entry, pc.USDToCNY, s.PromptTokens, s.CompletionTokens, s.CacheTokens, useCachePrice)
			costCNY := costUSD * pc.USDToCNY

			vals := []interface{}{
				s.Date, s.TokenName, s.ModelName, s.RequestCount,
				fmtTokensExcel(s.PromptTokens, humanFriendly),
				fmtTokensExcel(s.CacheTokens, humanFriendly),
				fmtTokensExcel(s.CompletionTokens, humanFriendly),
				fmtTokensExcel(s.TotalTokens, humanFriendly),
				fmt.Sprintf("%.6f", costUSD),
				fmt.Sprintf("%.4f", costCNY),
			}
			for col, v := range vals {
				cell, _ := excelize.CoordinatesToCellName(col+1, currentRow)
				f.SetCellValue(sheet, cell, v)
			}
			// Apply border style to data row
			rowStart, _ := excelize.CoordinatesToCellName(1, currentRow)
			rowEnd, _ := excelize.CoordinatesToCellName(colCount, currentRow)
			f.SetCellStyle(sheet, rowStart, rowEnd, borderStyle)

			subTotal.Requests += s.RequestCount
			subTotal.Prompt += s.PromptTokens
			subTotal.Cache += s.CacheTokens
			subTotal.Completion += s.CompletionTokens
			subTotal.Total += s.TotalTokens
			subTotal.CostUSD += costUSD
			subTotal.CostCNY += costCNY

			i++
			currentRow++
		}
		tokenEndRow := currentRow - 1

		// Merge Key名称 cells for this token group (column B)
		if tokenStartRow < tokenEndRow {
			f.MergeCell(sheet, fmt.Sprintf("B%d", tokenStartRow), fmt.Sprintf("B%d", tokenEndRow))
		}

		// Subtotal row with light blue background
		subTotalVals := []interface{}{"", "", "小计", subTotal.Requests,
			fmtTokensExcel(subTotal.Prompt, humanFriendly),
			fmtTokensExcel(subTotal.Cache, humanFriendly),
			fmtTokensExcel(subTotal.Completion, humanFriendly),
			fmtTokensExcel(subTotal.Total, humanFriendly),
			fmt.Sprintf("%.6f", subTotal.CostUSD),
			fmt.Sprintf("%.4f", subTotal.CostCNY),
		}
		for col, v := range subTotalVals {
			cell, _ := excelize.CoordinatesToCellName(col+1, currentRow)
			f.SetCellValue(sheet, cell, v)
		}
		// Apply combined border+fill style to subtotal row
		subtotalStart, _ := excelize.CoordinatesToCellName(1, currentRow)
		subtotalEnd, _ := excelize.CoordinatesToCellName(colCount, currentRow)
		f.SetCellStyle(sheet, subtotalStart, subtotalEnd, subtotalStyle)
		currentRow++

		// Accumulate grand total
		grandTotal.Requests += subTotal.Requests
		grandTotal.Prompt += subTotal.Prompt
		grandTotal.Cache += subTotal.Cache
		grandTotal.Completion += subTotal.Completion
		grandTotal.Total += subTotal.Total
		grandTotal.CostUSD += subTotal.CostUSD
		grandTotal.CostCNY += subTotal.CostCNY
	}

	// Grand total row
	grandTotalVals := []interface{}{"", "", "合计", grandTotal.Requests,
		fmtTokensExcel(grandTotal.Prompt, humanFriendly),
		fmtTokensExcel(grandTotal.Cache, humanFriendly),
		fmtTokensExcel(grandTotal.Completion, humanFriendly),
		fmtTokensExcel(grandTotal.Total, humanFriendly),
		fmt.Sprintf("%.6f", grandTotal.CostUSD),
		fmt.Sprintf("%.4f", grandTotal.CostCNY),
	}
	for col, v := range grandTotalVals {
		cell, _ := excelize.CoordinatesToCellName(col+1, currentRow)
		f.SetCellValue(sheet, cell, v)
	}
	// Apply border style to grand total row
	grandTotalStart, _ := excelize.CoordinatesToCellName(1, currentRow)
	grandTotalEnd, _ := excelize.CoordinatesToCellName(colCount, currentRow)
	f.SetCellStyle(sheet, grandTotalStart, grandTotalEnd, borderStyle)
}
