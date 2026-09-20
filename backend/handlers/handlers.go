package handlers

import (
	"bytes"
	"fmt"
	"math"
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
	api.GET("/models", func(c *gin.Context) { getModels(c, cfg) })
	api.GET("/stats/summary", func(c *gin.Context) { getSummary(c, cfg) })
	api.GET("/stats/daily", func(c *gin.Context) { getDaily(c, cfg) })
	api.GET("/stats/abnormal", func(c *gin.Context) { getAbnormal(c, cfg) })
	api.GET("/stats/requests", func(c *gin.Context) { getRequests(c, cfg) })
	api.GET("/export", func(c *gin.Context) { exportExcel(c, cfg) })
	api.GET("/export/abnormal", func(c *gin.Context) { exportAbnormalExcel(c, cfg) })
	api.GET("/export/requests", func(c *gin.Context) { exportRequestsExcel(c, cfg) })
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

	modelNamesRaw := c.Query("model_names")
	var modelNames []string
	for _, m := range strings.Split(modelNamesRaw, ",") {
		m = strings.TrimSpace(m)
		if m != "" {
			modelNames = append(modelNames, m)
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

	excludeAbnormal := c.Query("exclude_abnormal") == "1"

	return db.QueryParams{
		TokenNames:      tokenNames,
		ModelNames:      modelNames,
		Start:           start,
		End:             end,
		TableName:       tableName,
		ExcludeAbnormal: excludeAbnormal,
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

func getModels(c *gin.Context, cfg *config.Config) {
	names, err := db.GetAllModelNames()
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

func getAbnormal(c *gin.Context, cfg *config.Config) {
	p := parseQueryParams(c, cfg.DBTable)
	logs, err := db.GetAbnormalLogs(p)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": logs})
}

func getRequests(c *gin.Context, cfg *config.Config) {
	p := parseQueryParams(c, cfg.DBTable)

	page, _ := strconv.Atoi(c.Query("page"))
	pageSize, _ := strconv.Atoi(c.Query("page_size"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 1000 {
		pageSize = 50
	}

	total, err := db.CountRequestLogs(p)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}

	logs, err := db.GetRequestLogs(p, (page-1)*pageSize, pageSize)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}

	// Enrich each request with its CNY cost using the price config.
	useCachePrice := c.Query("use_cache_price") == "1"
	pc, _ := pricing.Load(cfg.DataDir)
	for i := range logs {
		entry := pricing.FindEntry(pc, logs[i].ModelName)
		costUSD := pricing.CalcCost(entry, pc.USDToCNY, logs[i].PromptTokens, logs[i].CompletionTokens, logs[i].CacheTokens, useCachePrice)
		logs[i].CostCNY = costUSD * pc.USDToCNY
	}

	// Total cost across ALL matching requests (not just the current page),
	// computed from per-model aggregated usage so it stays cheap.
	totalCostCNY := 0.0
	if stats, err := db.GetSummary(p); err == nil {
		for _, s := range stats {
			entry := pricing.FindEntry(pc, s.ModelName)
			totalCostCNY += pricing.CalcCost(entry, pc.USDToCNY, s.PromptTokens, s.CompletionTokens, s.CacheTokens, useCachePrice) * pc.USDToCNY
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"data":           logs,
		"total":          total,
		"page":           page,
		"page_size":      pageSize,
		"total_cost_cny": math.Round(totalCostCNY*10000) / 10000,
	})
}

// --- per-request detail export ---

// maxDataRowsPerSheet keeps each sheet below Excel's hard limit of
// 1,048,576 rows (2 rows are used for the time range and the header).
// minDataRowsPerSheet is the floor for the user-configured per-sheet row
// count, to avoid generating an absurd number of sheets.
const (
	maxDataRowsPerSheet = 1_000_000
	minDataRowsPerSheet = 10_000
)

// requestExportOptions carries the user-configurable options of the
// per-request detail export.
type requestExportOptions struct {
	useCachePrice  bool
	thousandSep    bool
	hideStatusCode bool
	sheetRows      int
}

func streamLabel(isStream bool) string {
	if isStream {
		return "是"
	}
	return "否"
}

// ttftValue returns the first-token latency in ms for streaming requests
// with a non-negative frt; "-" otherwise (non-streaming requests are
// recorded with frt = -1000, streaming errors with frt < 0).
func ttftValue(l models.RequestLog) interface{} {
	if l.IsStream && l.Frt >= 0 {
		return l.Frt
	}
	return "-"
}

func exportRequestsExcel(c *gin.Context, cfg *config.Config) {
	p := parseQueryParams(c, cfg.DBTable)

	// Per-sheet data row count; defaults to 1,000,000 and is clamped to
	// [10,000, 1,000,000] so a sheet can never exceed Excel's row limit.
	sheetRows, _ := strconv.Atoi(c.Query("sheet_rows"))
	if sheetRows <= 0 {
		sheetRows = maxDataRowsPerSheet
	}
	if sheetRows > maxDataRowsPerSheet {
		sheetRows = maxDataRowsPerSheet
	}
	if sheetRows < minDataRowsPerSheet {
		sheetRows = minDataRowsPerSheet
	}

	useCachePrice := c.Query("use_cache_price") == "1"
	opts := requestExportOptions{
		useCachePrice:  useCachePrice,
		thousandSep:    c.Query("thousand_sep") == "1",
		hideStatusCode: c.Query("hide_status_code") == "1",
		sheetRows:      sheetRows,
	}
	pc, err := pricing.Load(cfg.DataDir)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}

	f := excelize.NewFile()
	defer f.Close()

	timeRange := formatTimeRange(p.Start, p.End)

	// Create the summary sheet first so that it appears as the first tab;
	// its values are filled in after the data sheets have been streamed.
	if _, err := f.NewSheet(requestSummarySheetName); err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}

	usage, err := writeRequestSheets(f, p, timeRange, opts, pc)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}

	if err := writeRequestSummarySheet(f, p, usage, pc, timeRange, opts); err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}

	f.DeleteSheet("Sheet1")

	filename := fmt.Sprintf("token-usage-requests-%s.xlsx", time.Now().Format("20060102-150405"))
	c.Header("Content-Disposition", "attachment; filename="+filename)
	c.Header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	if err := f.Write(c.Writer); err != nil {
		// Headers are already sent at this point; nothing else to do.
		return
	}
}

// modelUsage accumulates per-model token usage during a streaming export so
// the summary sheet can compute the total cost from the price config.
type modelUsage struct {
	Requests    int64
	Prompt      int64
	Completion  int64
	CacheTokens int64
}

const requestSummarySheetName = "汇总"

// writeRequestSummarySheet writes the "汇总" sheet with overall totals and
// the total cost computed with the same pricing logic as the dashboard.
// When opts.thousandSep is true, numeric cells get a comma-grouped number
// format.
func writeRequestSummarySheet(f *excelize.File, p db.QueryParams, usage map[string]*modelUsage, pc *models.PriceConfig, timeRange string, opts requestExportOptions) error {
	sw, err := f.NewStreamWriter(requestSummarySheetName)
	if err != nil {
		return err
	}

	border := []excelize.Border{{Type: "left", Color: "000000", Style: 1}, {Type: "top", Color: "000000", Style: 1}, {Type: "right", Color: "000000", Style: 1}, {Type: "bottom", Color: "000000", Style: 1}}
	headerStyle, _ := f.NewStyle(&excelize.Style{
		Font:   &excelize.Font{Bold: true},
		Border: border,
	})
	dataStyle, _ := f.NewStyle(&excelize.Style{
		Border: border,
	})
	intNumStyle, costNumStyle := dataStyle, dataStyle
	if opts.thousandSep {
		intFmt := "#,##0"
		intNumStyle, _ = f.NewStyle(&excelize.Style{
			Border:       border,
			CustomNumFmt: &intFmt,
		})
		costFmt := "#,##0.0000"
		costNumStyle, _ = f.NewStyle(&excelize.Style{
			Border:       border,
			CustomNumFmt: &costFmt,
		})
	}

	models := make([]string, 0, len(usage))
	for m := range usage {
		models = append(models, m)
	}
	sort.Strings(models)

	var requests, prompt, completion, cache int64
	costUSD := 0.0
	var unpriced []string
	for _, m := range models {
		u := usage[m]
		requests += u.Requests
		prompt += u.Prompt
		completion += u.Completion
		cache += u.CacheTokens
		entry := pricing.FindEntry(pc, m)
		if entry == nil {
			unpriced = append(unpriced, m)
			continue
		}
		costUSD += pricing.CalcCost(entry, pc.USDToCNY, u.Prompt, u.Completion, u.CacheTokens, opts.useCachePrice)
	}
	costCNY := costUSD * pc.USDToCNY

	keysLabel := "全部"
	if len(p.TokenNames) > 0 {
		keysLabel = strings.Join(p.TokenNames, "、")
	}
	modelsLabel := "全部"
	if len(p.ModelNames) > 0 {
		modelsLabel = strings.Join(p.ModelNames, "、")
	}

	headers := []string{"Key名称", "模型", "请求数量", "输入 Tokens", "缓存命中 Tokens", "输出 Tokens", "总 Tokens", "费用 (USD)", "费用 (CNY)"}
	lastCol, _ := excelize.ColumnNumberToName(len(headers))

	// Widen columns so large token counts stay readable.
	if err := sw.SetColWidth(1, len(headers), 18); err != nil {
		return err
	}

	// Time range row (merged across all columns).
	cell, _ := excelize.CoordinatesToCellName(1, 1)
	if err := sw.SetRow(cell, []interface{}{excelize.Cell{StyleID: dataStyle, Value: "查询时间区间：" + timeRange}}); err != nil {
		return err
	}
	sw.MergeCell(cell, lastCol+"1")

	// Header row: Key/model filters first, then one column per metric.
	headerCells := make([]interface{}, len(headers))
	for i, h := range headers {
		headerCells[i] = excelize.Cell{StyleID: headerStyle, Value: h}
	}
	row := 2
	cell, _ = excelize.CoordinatesToCellName(1, row)
	if err := sw.SetRow(cell, headerCells); err != nil {
		return err
	}
	row++

	// Value row.
	values := []interface{}{
		keysLabel, modelsLabel,
		requests, prompt, cache, completion, prompt + completion,
		math.Round(costUSD*10000) / 10000, math.Round(costCNY*10000) / 10000,
	}
	valueCells := make([]interface{}, len(values))
	for i, v := range values {
		styleID := dataStyle
		if opts.thousandSep {
			switch v.(type) {
			case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
				styleID = intNumStyle
			case float32, float64:
				styleID = costNumStyle
			}
		}
		valueCells[i] = excelize.Cell{StyleID: styleID, Value: v}
	}
	cell, _ = excelize.CoordinatesToCellName(1, row)
	if err := sw.SetRow(cell, valueCells); err != nil {
		return err
	}
	row++

	// Optional note about models without a configured price.
	if len(unpriced) > 0 {
		cell, _ = excelize.CoordinatesToCellName(1, row)
		if err := sw.SetRow(cell, []interface{}{
			excelize.Cell{StyleID: dataStyle, Value: "未配置价格的模型（未计入费用）：" + strings.Join(unpriced, "、")},
		}); err != nil {
			return err
		}
		sw.MergeCell(cell, lastCol+strconv.Itoa(row))
		row++
	}

	// Cost calculation formula note.
	row++ // blank row
	cell, _ = excelize.CoordinatesToCellName(1, row)
	if err := sw.SetRow(cell, []interface{}{
		excelize.Cell{StyleID: dataStyle, Value: "费用计算公式：费用 = (非缓存 token 数 × 输入价格 + 缓存 token 数 × 缓存价格 + 补全 token 数 × 输出价格) / 1,000,000（价格单位：元 / 百万 tokens）"},
	}); err != nil {
		return err
	}
	sw.MergeCell(cell, lastCol+strconv.Itoa(row))
	row++

	// Model billing prices table (CNY per million tokens).
	priceHeaders := []string{"模型", "输入价格(元/百万 tokens)", "缓存价格(元/百万 tokens)", "输出价格(元/百万 tokens)"}
	priceHeaderCells := make([]interface{}, len(priceHeaders))
	for i, h := range priceHeaders {
		priceHeaderCells[i] = excelize.Cell{StyleID: headerStyle, Value: h}
	}
	cell, _ = excelize.CoordinatesToCellName(1, row)
	if err := sw.SetRow(cell, priceHeaderCells); err != nil {
		return err
	}
	row++
	for _, m := range models {
		entry := pricing.FindEntry(pc, m)
		var inCNY, cacheCNY, outCNY float64
		if entry != nil {
			inCNY = pricing.ToCNY(entry.InputPrice, entry.Currency, pc.USDToCNY)
			cacheCNY = pricing.ToCNY(entry.CachePrice, entry.Currency, pc.USDToCNY)
			outCNY = pricing.ToCNY(entry.OutputPrice, entry.Currency, pc.USDToCNY)
		}
		priceCells := []interface{}{
			m,
			math.Round(inCNY*10000) / 10000,
			math.Round(cacheCNY*10000) / 10000,
			math.Round(outCNY*10000) / 10000,
		}
		pc2 := make([]interface{}, len(priceCells))
		for i, v := range priceCells {
			styleID := dataStyle
			if opts.thousandSep {
				switch v.(type) {
				case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
					styleID = intNumStyle
				case float32, float64:
					styleID = costNumStyle
				}
			}
			pc2[i] = excelize.Cell{StyleID: styleID, Value: v}
		}
		cell, _ = excelize.CoordinatesToCellName(1, row)
		if err := sw.SetRow(cell, pc2); err != nil {
			return err
		}
		row++
	}
	return nil
}

// writeRequestSheets streams all matching request records into the workbook
// using excelize's StreamWriter, splitting into multiple sheets whenever
// opts.sheetRows data rows have been written to the current sheet. It returns
// the per-model usage accumulated while streaming, for the summary sheet.
// When opts.thousandSep is true, numeric cells get a comma-grouped number
// format; when opts.hideStatusCode is true, the status-code column is
// omitted.
func writeRequestSheets(f *excelize.File, p db.QueryParams, timeRange string, opts requestExportOptions, pc *models.PriceConfig) (map[string]*modelUsage, error) {
	usage := map[string]*modelUsage{}
	getUsage := func(model string) *modelUsage {
		u, ok := usage[model]
		if !ok {
			u = &modelUsage{}
			usage[model] = u
		}
		return u
	}

	headers := []string{"时间", "Key名称", "模型", "耗时(秒)", "流式", "TTFT(ms)", "输入Tokens", "缓存命中Tokens", "输出Tokens", "总Tokens"}
	if !opts.hideStatusCode {
		headers = append(headers, "状态码")
	}
	headers = append(headers, "费用(CNY)")

	border := []excelize.Border{{Type: "left", Color: "000000", Style: 1}, {Type: "top", Color: "000000", Style: 1}, {Type: "right", Color: "000000", Style: 1}, {Type: "bottom", Color: "000000", Style: 1}}
	headerStyle, _ := f.NewStyle(&excelize.Style{
		Font:   &excelize.Font{Bold: true},
		Border: border,
	})
	dataStyle, _ := f.NewStyle(&excelize.Style{
		Border: border,
	})
	dataNumStyle := dataStyle
	costNumStyle := dataStyle
	if opts.thousandSep {
		numFmt := "#,##0"
		dataNumStyle, _ = f.NewStyle(&excelize.Style{
			Border:       border,
			CustomNumFmt: &numFmt,
		})
		costFmt := "#,##0.0000"
		costNumStyle, _ = f.NewStyle(&excelize.Style{
			Border:       border,
			CustomNumFmt: &costFmt,
		})
	}

	sheetCount := 0
	var sw *excelize.StreamWriter
	sheetRow := 0 // current row index within the sheet (1-based)
	dataRows := 0 // data rows written to the current sheet

	newSheet := func() error {
		sheetCount++
		name := "请求明细"
		if sheetCount > 1 {
			name = fmt.Sprintf("请求明细%d", sheetCount)
		}
		if _, err := f.NewSheet(name); err != nil {
			return err
		}
		var err error
		sw, err = f.NewStreamWriter(name)
		if err != nil {
			return err
		}
		lastCol, _ := excelize.ColumnNumberToName(len(headers))
		if err := sw.SetRow("A1", []interface{}{
			excelize.Cell{StyleID: headerStyle, Value: "查询时间区间：" + timeRange},
		}); err != nil {
			return err
		}
		sw.MergeCell("A1", lastCol+"1")
		headerCells := make([]interface{}, len(headers))
		for i, h := range headers {
			headerCells[i] = excelize.Cell{StyleID: headerStyle, Value: h}
		}
		if err := sw.SetRow("A2", headerCells); err != nil {
			return err
		}
		sheetRow = 2
		dataRows = 0
		return nil
	}

	if err := newSheet(); err != nil {
		return nil, err
	}

	err := db.StreamRequestLogs(p, 1000, func(batch []models.RequestLog) error {
		for _, l := range batch {
			if dataRows >= opts.sheetRows {
				if err := sw.Flush(); err != nil {
					return err
				}
				if err := newSheet(); err != nil {
					return err
				}
			}
			sheetRow++
			entry := pricing.FindEntry(pc, l.ModelName)
			costCNY := 0.0
			if entry != nil {
				costCNY = pricing.CalcCost(entry, pc.USDToCNY, l.PromptTokens, l.CompletionTokens, l.CacheTokens, opts.useCachePrice) * pc.USDToCNY
			}
			vals := []interface{}{
				l.CreatedAt, l.TokenName, l.ModelName, l.UseTime,
				streamLabel(l.IsStream), ttftValue(l),
				l.PromptTokens, l.CacheTokens, l.CompletionTokens, l.TotalTokens,
			}
			if !opts.hideStatusCode {
				vals = append(vals, l.StatusCode)
			}
			vals = append(vals, math.Round(costCNY*10000)/10000)
			cells := make([]interface{}, len(vals))
			for i, v := range vals {
				styleID := dataStyle
				if opts.thousandSep {
					switch v.(type) {
					case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
						styleID = dataNumStyle
					case float32, float64:
						styleID = costNumStyle
					}
				}
				cells[i] = excelize.Cell{StyleID: styleID, Value: v}
			}
			cell, _ := excelize.CoordinatesToCellName(1, sheetRow)
			if err := sw.SetRow(cell, cells); err != nil {
				return err
			}
			dataRows++

			u := getUsage(l.ModelName)
			u.Requests++
			u.Prompt += l.PromptTokens
			u.Completion += l.CompletionTokens
			u.CacheTokens += l.CacheTokens
		}
		return nil
	})
	return usage, err
}

func exportAbnormalExcel(c *gin.Context, cfg *config.Config) {
	p := parseQueryParams(c, cfg.DBTable)
	humanFriendly := c.Query("human_friendly") == "1"

	logs, err := db.GetAbnormalLogs(p)
	if err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}

	f := excelize.NewFile()
	defer f.Close()

	timeRange := formatTimeRange(p.Start, p.End)
	writeAbnormalSheet(f, logs, timeRange, humanFriendly)

	f.DeleteSheet("Sheet1")

	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		errJSON(c, http.StatusInternalServerError, err.Error())
		return
	}

	filename := fmt.Sprintf("token-usage-abnormal-%s.xlsx", time.Now().Format("20060102-150405"))
	c.Header("Content-Disposition", "attachment; filename="+filename)
	c.Header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buf.Bytes())
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
			roundedUSD := math.Round(costUSD*10000) / 10000
			roundedCNY := math.Round(costCNY*10000) / 10000

			vals := []interface{}{
				s.TokenName, s.ModelName, s.RequestCount,
				fmtTokensExcel(s.PromptTokens, humanFriendly),
				fmtTokensExcel(s.CacheTokens, humanFriendly),
				fmtTokensExcel(s.CompletionTokens, humanFriendly),
				fmtTokensExcel(s.TotalTokens, humanFriendly),
				fmt.Sprintf("%.4f", roundedUSD),
				fmt.Sprintf("%.4f", roundedCNY),
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
			subTotal.CostUSD += roundedUSD
			subTotal.CostCNY += roundedCNY
			grandTotal.CostUSD += roundedUSD
			grandTotal.CostCNY += roundedCNY

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
			fmt.Sprintf("%.4f", subTotal.CostUSD),
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

		// Accumulate grand total tokens (costs already accumulated per model row above)
		grandTotal.Requests += subTotal.Requests
		grandTotal.Prompt += subTotal.Prompt
		grandTotal.Cache += subTotal.Cache
		grandTotal.Completion += subTotal.Completion
		grandTotal.Total += subTotal.Total
	}

	// Grand total row
	grandTotalVals := []interface{}{"", "合计", grandTotal.Requests,
		fmtTokensExcel(grandTotal.Prompt, humanFriendly),
		fmtTokensExcel(grandTotal.Cache, humanFriendly),
		fmtTokensExcel(grandTotal.Completion, humanFriendly),
		fmtTokensExcel(grandTotal.Total, humanFriendly),
		fmt.Sprintf("%.4f", grandTotal.CostUSD),
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

func writeAbnormalSheet(f *excelize.File, logs []models.AbnormalLog, timeRange string, humanFriendly bool) {
	sheet := "异常请求"
	f.NewSheet(sheet)

	colCount := 8
	lastCol, _ := excelize.ColumnNumberToName(colCount)

	borderStyle, _ := f.NewStyle(&excelize.Style{
		Border: []excelize.Border{{Type: "left", Color: "000000", Style: 1}, {Type: "top", Color: "000000", Style: 1}, {Type: "right", Color: "000000", Style: 1}, {Type: "bottom", Color: "000000", Style: 1}},
	})

	f.SetCellValue(sheet, "A1", "查询时间区间："+timeRange)
	f.MergeCell(sheet, "A1", lastCol+"1")

	headers := []string{"时间", "Key名称", "模型", "输入Tokens", "缓存读Tokens", "输出Tokens", "总Tokens", "错误原因"}
	for i, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 2)
		f.SetCellValue(sheet, cell, h)
	}
	f.SetCellStyle(sheet, "A2", lastCol+"2", borderStyle)

	currentRow := 3
	for _, l := range logs {
		vals := []interface{}{
			l.CreatedAt, l.TokenName, l.ModelName,
			fmtTokensExcel(l.PromptTokens, humanFriendly),
			fmtTokensExcel(l.CacheTokens, humanFriendly),
			fmtTokensExcel(l.CompletionTokens, humanFriendly),
			fmtTokensExcel(l.TotalTokens, humanFriendly),
			l.ErrorReason,
		}
		for col, v := range vals {
			cell, _ := excelize.CoordinatesToCellName(col+1, currentRow)
			f.SetCellValue(sheet, cell, v)
		}
		rowStart, _ := excelize.CoordinatesToCellName(1, currentRow)
		rowEnd, _ := excelize.CoordinatesToCellName(colCount, currentRow)
		f.SetCellStyle(sheet, rowStart, rowEnd, borderStyle)
		currentRow++
	}
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
				fmt.Sprintf("%.4f", costUSD),
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
			fmt.Sprintf("%.4f", subTotal.CostUSD),
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
		fmt.Sprintf("%.4f", grandTotal.CostUSD),
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
