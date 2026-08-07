import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Col, DatePicker, message, Row, Select, Space,
  Statistic, Table, Tabs, Tag, Tooltip, Typography, Segmented,
} from 'antd';
import { DownloadOutlined, InfoCircleOutlined, NumberOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { SortOrder } from 'antd/es/table/interface';
import dayjs, { Dayjs } from 'dayjs';
import ExcelJS from 'exceljs';
import { fetchAbnormal, fetchDaily, fetchPrices, fetchSummary, fetchTokenNames, QueryParams } from '../api';
import type { AbnormalLog, DailyCost, DailyStat, ModelCost, ModelStat, PriceConfig, PriceEntry, SummaryResult } from '../types';

const { RangePicker } = DatePicker;
const { Text } = Typography;

const DATETIME_FMT = 'YYYY-MM-DD HH:mm:ss';

type Granularity = 'today' | 'week' | 'month' | 'last30' | 'all' | 'custom';
type ModelRow = ModelCost & { isSubtotal?: boolean; keyRowSpan: number; isGroupFirst?: boolean };
type DailyRow = DailyCost & { isDateSubtotal?: boolean; dateRowSpan: number; isDateFirst?: boolean };

const GRANULARITY_OPTIONS: { label: string; value: Granularity }[] = [
  { label: '今日', value: 'today' },
  { label: '本周', value: 'week' },
  { label: '本月', value: 'month' },
  { label: '近30天', value: 'last30' },
  { label: '所有时间', value: 'all' },
  { label: '自定义', value: 'custom' },
];

function addThousandSep(s: string): string {
  const parts = s.split('.');
  const sign = parts[0].startsWith('-') ? '-' : '';
  parts[0] = sign ? parts[0].slice(1) : parts[0];
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + parts.join('.');
}

function fmtNum(n: number, sep = false): string {
  if (n >= 1_000_000) {
    const val = n / 1_000_000;
    const s = Number.isInteger(val) ? String(val) : val.toFixed(2);
    return (sep ? addThousandSep(s) : s) + 'M';
  }
  if (n >= 1_000) {
    const val = n / 1_000;
    const s = Number.isInteger(val) ? String(val) : val.toFixed(1);
    return (sep ? addThousandSep(s) : s) + 'K';
  }
  return sep ? n.toLocaleString() : String(n);
}

function fmtHuman(n: number, sep = false): string {
  if (n >= 1_000_000) {
    const val = n / 1_000_000;
    const s = Number.isInteger(val) ? String(val) : val.toFixed(3);
    return (sep ? addThousandSep(s) : s) + 'M';
  }
  if (n >= 1_000) {
    const val = n / 1_000;
    const s = Number.isInteger(val) ? String(val) : val.toFixed(3);
    return (sep ? addThousandSep(s) : s) + 'K';
  }
  return sep ? n.toLocaleString() : String(n);
}

// ---------- cost helpers (mirror backend pricing.FindEntry / pricing.CalcCost) ----------

function findPriceEntry(config: PriceConfig | null, modelName: string): PriceEntry | null {
  if (!config?.entries?.length) return null;
  const lower = modelName.toLowerCase();
  for (const e of config.entries) {
    if (e.model_id.toLowerCase() === lower) return e;
  }
  for (const e of config.entries) {
    for (const alias of (e.aliases ?? [])) {
      if (lower.includes(alias.toLowerCase()) || alias.toLowerCase() === lower) return e;
    }
  }
  return null;
}

function calcCostUSD(
  entry: PriceEntry | null,
  promptTokens: number,
  completionTokens: number,
  cacheTokens: number,
  useCachePrice: boolean,
  usdToCNY: number,
): number {
  if (!entry) return 0;
  const ec = (entry.currency || 'USD').toUpperCase();
  const norm = (p: number) => ec === 'CNY' && usdToCNY > 0 ? p / usdToCNY : p;
  const inputPrice = norm(entry.input_price);
  const outputPrice = norm(entry.output_price);
  const outputCost = completionTokens * outputPrice / 1_000_000;
  if (useCachePrice && cacheTokens > 0) {
    const cp = norm(entry.cache_price) > 0 ? norm(entry.cache_price) : inputPrice;
    const nonCache = Math.max(0, promptTokens - cacheTokens);
    return nonCache * inputPrice / 1_000_000 + cacheTokens * cp / 1_000_000 + outputCost;
  }
  return promptTokens * inputPrice / 1_000_000 + outputCost;
}

// ---------- end cost helpers ----------

function fmtUSD(n: number, sep = false): string {
  return '$' + (sep ? addThousandSep(n.toFixed(4)) : n.toFixed(4));
}

function fmtCNY(n: number, sep = false): string {
  return '¥' + (sep ? addThousandSep(n.toFixed(4)) : n.toFixed(4));
}

function computeTimeRange(gran: Granularity, custom: [Dayjs, Dayjs] | null): [Dayjs, Dayjs] | null {
  const now = dayjs();
  switch (gran) {
    case 'today': return [now.startOf('day'), now.endOf('day')];
    case 'week': {
      const wd = now.day() === 0 ? 7 : now.day();
      return [now.subtract(wd - 1, 'day').startOf('day'), now];
    }
    case 'month': return [now.startOf('month'), now];
    case 'last30': return [now.subtract(30, 'day'), now];
    case 'all': return null;
    case 'custom': return custom;
    default: return null;
  }
}

function timeRangeLabel(range: [Dayjs, Dayjs] | null): string {
  if (!range) return '全部时间';
  return `${range[0].format(DATETIME_FMT)} ~ ${range[1].format(DATETIME_FMT)}`;
}

export default function Dashboard() {
  const [tokenNames, setTokenNames] = useState<string[]>([]);
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const [granularity, setGranularity] = useState<Granularity>('last30');
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [loading, setLoading] = useState(false);
  const [priceConfig, setPriceConfig] = useState<PriceConfig | null>(null);
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [rawByModel, setRawByModel] = useState<ModelStat[]>([]);
  const [rawDaily, setRawDaily] = useState<DailyStat[]>([]);
  const [abnormalLogs, setAbnormalLogs] = useState<AbnormalLog[]>([]);
  const [activeTab, setActiveTab] = useState('model');
  const [humanFriendly, setHumanFriendly] = useState(true);
  const [thousandSep, setThousandSep] = useState(true);
  const [useCachePrice, setUseCachePrice] = useState(true);
  const [calcCost, setCalcCost] = useState(true);
  const [showUSD, setShowUSD] = useState(false);
  const [modelSortField, setModelSortField] = useState<keyof ModelCost | ''>('');
  const [modelSortOrder, setModelSortOrder] = useState<SortOrder>(null);
  const [showDailySubtotals, setShowDailySubtotals] = useState(true);
  const [dailySortOrder, setDailySortOrder] = useState<SortOrder>('ascend');
  const [dailyOnlyTotals, setDailyOnlyTotals] = useState(false);
  const [excludeAbnormal, setExcludeAbnormal] = useState(false);

  useEffect(() => {
    fetchTokenNames()
      .then(setTokenNames)
      .catch(() => message.error('加载 Token 列表失败'));
    fetchPrices()
      .then(setPriceConfig)
      .catch(() => {});
  }, []);

  const byModel = useMemo<ModelCost[]>(() =>
    rawByModel.map(s => {
      const entry = findPriceEntry(priceConfig, s.model_name);
      const usdToCNY = priceConfig?.usd_to_cny ?? 7.25;
      const costUSD = calcCostUSD(entry, s.prompt_tokens, s.completion_tokens, s.cache_tokens, useCachePrice, usdToCNY);
      return { ...s, cost_usd: costUSD, cost_cny: costUSD * usdToCNY };
    }),
  [rawByModel, priceConfig, useCachePrice]);

  const daily = useMemo<DailyCost[]>(() =>
    rawDaily.map(s => {
      const entry = findPriceEntry(priceConfig, s.model_name);
      const usdToCNY = priceConfig?.usd_to_cny ?? 7.25;
      const costUSD = calcCostUSD(entry, s.prompt_tokens, s.completion_tokens, s.cache_tokens, useCachePrice, usdToCNY);
      return { ...s, cost_usd: costUSD, cost_cny: costUSD * usdToCNY };
    }),
  [rawDaily, priceConfig, useCachePrice]);

  const timeRange = useMemo(() => computeTimeRange(granularity, customRange), [granularity, customRange]);
  const timeLabel = useMemo(() => timeRangeLabel(timeRange), [timeRange]);

  const fmtTableToken = useCallback((n: number) => humanFriendly ? fmtHuman(n, thousandSep) : (thousandSep ? n.toLocaleString() : String(n)), [humanFriendly, thousandSep]);
  const fmtSummaryToken = useCallback((n: number) => humanFriendly ? fmtHuman(n, thousandSep) : fmtNum(n, thousandSep), [humanFriendly, thousandSep]);
  const fmtCount = useCallback((n: number) => thousandSep ? n.toLocaleString() : String(n), [thousandSep]);
  const fmtUSDLocal = useCallback((n: number) => fmtUSD(n, thousandSep), [thousandSep]);
  const fmtCNYLocal = useCallback((n: number) => fmtCNY(n, thousandSep), [thousandSep]);

  // Group byModel data by token_name with subtotals
  const groupedModelData = useMemo(() => {
    if (!byModel.length) return { rows: [] as ModelRow[], subtotals: [] as { tokenName: string; data: ModelCost }[], grandTotal: null as ModelCost | null };
    
    const groups = new Map<string, ModelCost[]>();
    for (const item of byModel) {
      if (!groups.has(item.token_name)) {
        groups.set(item.token_name, []);
      }
      groups.get(item.token_name)!.push(item);
    }
    
    // Pre-compute subtotals so group sort can use them
    const subtotalMap = new Map<string, ModelCost>();
    for (const [tokenName, items] of groups) {
      const subtotal: ModelCost = {
        token_name: tokenName,
        model_name: '小计',
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_tokens: 0,
        total_tokens: 0,
        quota: 0,
        request_count: 0,
        cost_usd: 0,
        cost_cny: 0,
      };
      for (const item of items) {
        subtotal.prompt_tokens += item.prompt_tokens;
        subtotal.completion_tokens += item.completion_tokens;
        subtotal.cache_tokens += item.cache_tokens;
        subtotal.total_tokens += item.total_tokens;
        subtotal.quota += item.quota;
        subtotal.request_count += item.request_count;
        subtotal.cost_usd += item.cost_usd;
        subtotal.cost_cny += item.cost_cny;
      }
      subtotalMap.set(tokenName, subtotal);
    }
    
    // Sort groups by subtotal value when a sort is active
    let groupEntries = [...groups.entries()];
    if (modelSortField && modelSortOrder) {
      groupEntries.sort(([aKey], [bKey]) => {
        const aSub = subtotalMap.get(aKey)!;
        const bSub = subtotalMap.get(bKey)!;
        const diff = (aSub[modelSortField as keyof ModelCost] as number) - (bSub[modelSortField as keyof ModelCost] as number);
        return modelSortOrder === 'ascend' ? diff : -diff;
      });
    }
    
    const rows: ModelRow[] = [];
    const subtotals: { tokenName: string; data: ModelCost }[] = [];
    
    for (const [tokenName, items] of groupEntries) {
      const subtotal = subtotalMap.get(tokenName)!;
      subtotals.push({ tokenName, data: subtotal });
      
      // Sort items within group; subtotal always appears last
      const sortedItems = modelSortField && modelSortOrder
        ? [...items].sort((a, b) => {
            const diff = (a[modelSortField as keyof ModelCost] as number) - (b[modelSortField as keyof ModelCost] as number);
            return modelSortOrder === 'ascend' ? diff : -diff;
          })
        : items;
      
      const groupSize = sortedItems.length + 1; // data rows + subtotal row
      sortedItems.forEach((item, idx) => {
        rows.push({ ...item, keyRowSpan: idx === 0 ? groupSize : 0, isGroupFirst: idx === 0 });
      });
      
      // Subtotal row always last in group
      rows.push({ ...subtotal, isSubtotal: true, keyRowSpan: 0, isGroupFirst: false });
    }
    
    const grandTotal: ModelCost = {
      token_name: '合计', model_name: '',
      prompt_tokens: 0, completion_tokens: 0, cache_tokens: 0,
      total_tokens: 0, quota: 0, request_count: 0,
      cost_usd: 0, cost_cny: 0,
    };
    for (const item of byModel) {
      grandTotal.prompt_tokens += item.prompt_tokens;
      grandTotal.completion_tokens += item.completion_tokens;
      grandTotal.cache_tokens += item.cache_tokens;
      grandTotal.total_tokens += item.total_tokens;
      grandTotal.quota += item.quota;
      grandTotal.request_count += item.request_count;
      grandTotal.cost_usd += item.cost_usd;
      grandTotal.cost_cny += item.cost_cny;
    }

    return { rows, subtotals, grandTotal };
  }, [byModel, modelSortField, modelSortOrder]);

  const groupedDailyData = useMemo(() => {
    if (!daily.length) return { rows: [] as DailyRow[], grandTotal: null as DailyCost | null };

    const groups = new Map<string, DailyCost[]>();
    for (const item of daily) {
      if (!groups.has(item.date)) groups.set(item.date, []);
      groups.get(item.date)!.push(item);
    }

    const sortedEntries = [...groups.entries()].sort(([a], [b]) =>
      dailySortOrder === 'descend' ? b.localeCompare(a) : a.localeCompare(b)
    );

    const grandTotal: DailyCost = {
      date: '', token_name: '', model_name: '合计',
      prompt_tokens: 0, completion_tokens: 0, cache_tokens: 0,
      total_tokens: 0, quota: 0, request_count: 0,
      cost_usd: 0, cost_cny: 0,
    };

    const rows: DailyRow[] = [];
    for (const [date, items] of sortedEntries) {
      const subtotal: DailyCost = {
        date, token_name: '', model_name: '小计',
        prompt_tokens: 0, completion_tokens: 0, cache_tokens: 0,
        total_tokens: 0, quota: 0, request_count: 0,
        cost_usd: 0, cost_cny: 0,
      };
      for (const item of items) {
        subtotal.prompt_tokens += item.prompt_tokens;
        subtotal.completion_tokens += item.completion_tokens;
        subtotal.cache_tokens += item.cache_tokens;
        subtotal.total_tokens += item.total_tokens;
        subtotal.quota += item.quota;
        subtotal.request_count += item.request_count;
        subtotal.cost_usd += item.cost_usd;
        subtotal.cost_cny += item.cost_cny;
        grandTotal.prompt_tokens += item.prompt_tokens;
        grandTotal.completion_tokens += item.completion_tokens;
        grandTotal.cache_tokens += item.cache_tokens;
        grandTotal.total_tokens += item.total_tokens;
        grandTotal.quota += item.quota;
        grandTotal.request_count += item.request_count;
        grandTotal.cost_usd += item.cost_usd;
        grandTotal.cost_cny += item.cost_cny;
      }
      if (dailyOnlyTotals) {
        rows.push({ ...subtotal, model_name: '每日合计', isDateSubtotal: false, dateRowSpan: 1, isDateFirst: true });
      } else {
        const groupSize = showDailySubtotals ? items.length + 1 : items.length;
        items.forEach((item, idx) => {
          rows.push({ ...item, dateRowSpan: idx === 0 ? groupSize : 0, isDateFirst: idx === 0 });
        });
        if (showDailySubtotals) {
          rows.push({ ...subtotal, isDateSubtotal: true, dateRowSpan: 0, isDateFirst: false });
        }
      }
    }
    return { rows, grandTotal };
  }, [daily, showDailySubtotals, dailySortOrder, dailyOnlyTotals]);

  const buildQueryParams = useCallback((): QueryParams => {
    const p: QueryParams = { token_names: selectedTokens };
    if (excludeAbnormal) p.exclude_abnormal = true;
    if (granularity !== 'custom') {
      p.granularity = granularity;
    } else if (customRange) {
      p.start = customRange[0].unix();
      p.end = customRange[1].unix();
    }
    return p;
  }, [selectedTokens, granularity, customRange, excludeAbnormal]);

  const query = useCallback(async () => {
    setLoading(true);
    try {
      const p = buildQueryParams();
      // Abnormal-log query targets the abnormal records themselves, so it
      // should not be affected by the "排除异常请求" toggle.
      const abnormalParams: QueryParams = { ...p, exclude_abnormal: false };
      const [summaryRes, dailyRes, abnormalRes, pc] = await Promise.all([
        fetchSummary(p),
        fetchDaily(p),
        fetchAbnormal(abnormalParams),
        fetchPrices(),
      ]);
      setPriceConfig(pc);
      setSummary(summaryRes.summary);
      setRawByModel(summaryRes.summary.by_model);
      setRawDaily(dailyRes);
      setAbnormalLogs(abnormalRes);
    } catch (e: unknown) {
      message.error('查询失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [buildQueryParams]);

  const handleExport = async () => {
    const fmtTok = (n: number): string | number => humanFriendly ? fmtHuman(n, thousandSep) : n;
    const fmtCost = (n: number): string => n > 0 ? (thousandSep ? addThousandSep((Math.round(n * 10000) / 10000).toFixed(4)) : (Math.round(n * 10000) / 10000).toFixed(4)) : '';

    const borderStyle: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FF000000' } };
    const allBorders: Partial<ExcelJS.Borders> = {
      top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle,
    };

    function applySheetBordersAndMerge(
      ws: ExcelJS.Worksheet,
      totalCols: number,
      dataStartRow: number, // 1-indexed row where data begins (after time range + header)
      keyMerges?: { startRow: number; endRow: number }[],
    ) {
      const totalRows = ws.rowCount;
      // Merge time range row across all columns
      ws.mergeCells(1, 1, 1, totalCols);
      // Apply borders to all cells in the used range
      for (let r = 1; r <= totalRows; r++) {
        for (let c = 1; c <= totalCols; c++) {
          const cell = ws.getCell(r, c);
          cell.border = allBorders;
        }
      }
      // Merge first-column cells for grouped rows
      if (keyMerges) {
        for (const { startRow, endRow } of keyMerges) {
          if (endRow > startRow) {
            ws.mergeCells(startRow, 1, endRow, 1);
          }
        }
      }
      // Re-apply border to merged cells (mergeCells resets style) and apply
      // thousand-separator number format to numeric data cells when enabled.
      for (let r = 1; r <= totalRows; r++) {
        for (let c = 1; c <= totalCols; c++) {
          const cell = ws.getCell(r, c);
          cell.border = allBorders;
          if (thousandSep && r >= dataStartRow && typeof cell.value === 'number') {
            cell.numFmt = '#,##0';
          }
        }
      }
      void dataStartRow;
    }

    const subtotalFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFE3F2FD' } };

    const wb = new ExcelJS.Workbook();

    if (activeTab === 'model') {
      // ── 按模型汇总 ──
      const summarySheet = wb.addWorksheet('模型汇总');
      const SUMMARY_COLS = 7 + (calcCost && showUSD ? 1 : 0) + (calcCost ? 1 : 0);
      summarySheet.addRow([`查询时间区间：${timeLabel}`]);
      const summaryHeader = ['Key名称', '模型', '请求次数', '输入Tokens', '缓存读Tokens', '输出Tokens', '总Tokens'];
      if (calcCost && showUSD) summaryHeader.push('费用(USD)');
      if (calcCost) summaryHeader.push('费用(CNY)');
      summarySheet.addRow(summaryHeader);

      const buildSummaryRow = (tokenName: string, modelName: string, rc: number, pt: number, ct: number, cpt: number, tt: number, usd: number, cny: number) => {
        const cells: (string | number)[] = [tokenName, modelName, rc, fmtTok(pt), fmtTok(ct), fmtTok(cpt), fmtTok(tt)];
        if (calcCost && showUSD) cells.push(fmtCost(usd));
        if (calcCost) cells.push(fmtCost(cny));
        return cells;
      };

      const summaryKeyMerges: { startRow: number; endRow: number }[] = [];
      const summarySubtotalRows: number[] = [];
      for (const row of groupedModelData.rows) {
        const excelRow = summarySheet.rowCount + 1;
        summarySheet.addRow(buildSummaryRow(
          row.token_name, row.model_name, row.request_count,
          row.prompt_tokens, row.cache_tokens, row.completion_tokens, row.total_tokens,
          row.cost_usd, row.cost_cny,
        ));
        if (row.keyRowSpan > 1) {
          summaryKeyMerges.push({ startRow: excelRow, endRow: excelRow + row.keyRowSpan - 1 });
        }
        if (row.isSubtotal) summarySubtotalRows.push(excelRow);
      }
      if (groupedModelData.grandTotal) {
        const gt = groupedModelData.grandTotal;
        const gtRow = summarySheet.rowCount + 1;
        summarySheet.addRow(buildSummaryRow(
          '合计', '', gt.request_count,
          gt.prompt_tokens, gt.cache_tokens, gt.completion_tokens, gt.total_tokens,
          gt.cost_usd, gt.cost_cny,
        ));
        summarySubtotalRows.push(gtRow);
      }
      applySheetBordersAndMerge(summarySheet, SUMMARY_COLS, 3, summaryKeyMerges);
      for (const r of summarySubtotalRows) {
        for (let c = 1; c <= SUMMARY_COLS; c++) summarySheet.getCell(r, c).fill = subtotalFill;
      }
    } else if (activeTab === 'abnormal') {
      // ── 异常请求明细 ──
      const abnormalSheet = wb.addWorksheet('异常请求');
      const ABNORMAL_COLS = 8;
      abnormalSheet.addRow([`查询时间区间：${timeLabel}`]);
      abnormalSheet.addRow(['时间', 'Key名称', '模型', '输入Tokens', '缓存读Tokens', '输出Tokens', '总Tokens', '错误原因']);
      for (const log of abnormalLogs) {
        abnormalSheet.addRow([
          log.created_at, log.token_name, log.model_name,
          fmtTok(log.prompt_tokens), fmtTok(log.cache_tokens), fmtTok(log.completion_tokens), fmtTok(log.total_tokens),
          log.error_reason,
        ]);
      }
      applySheetBordersAndMerge(abnormalSheet, ABNORMAL_COLS, 3);
    } else {
      // ── 每日明细 ──
      const dailySheet = wb.addWorksheet('每日明细');
      const DAILY_COLS = 8 + (calcCost && showUSD ? 1 : 0) + (calcCost ? 1 : 0);
      dailySheet.addRow([`查询时间区间：${timeLabel}`]);
      const dailyHeader = ['日期', 'Key名称', '模型', '请求次数', '输入Tokens', '缓存读Tokens', '输出Tokens', '总Tokens'];
      if (calcCost && showUSD) dailyHeader.push('费用(USD)');
      if (calcCost) dailyHeader.push('费用(CNY)');
      dailySheet.addRow(dailyHeader);

      const buildDailyRow = (date: string, tokenName: string, modelName: string, rc: number, pt: number, ct: number, cpt: number, tt: number, usd: number, cny: number) => {
        const cells: (string | number)[] = [date, tokenName, modelName, rc, fmtTok(pt), fmtTok(ct), fmtTok(cpt), fmtTok(tt)];
        if (calcCost && showUSD) cells.push(fmtCost(usd));
        if (calcCost) cells.push(fmtCost(cny));
        return cells;
      };

      const dateKeyMerges: { startRow: number; endRow: number }[] = [];
      const dailySubtotalRows: number[] = [];
      for (const row of groupedDailyData.rows) {
        const excelRow = dailySheet.rowCount + 1;
        dailySheet.addRow(buildDailyRow(
          row.date.slice(0, 10), row.token_name, row.model_name, row.request_count,
          row.prompt_tokens, row.cache_tokens, row.completion_tokens, row.total_tokens,
          row.cost_usd, row.cost_cny,
        ));
        if (row.dateRowSpan > 1) {
          dateKeyMerges.push({ startRow: excelRow, endRow: excelRow + row.dateRowSpan - 1 });
        }
        if (row.isDateSubtotal) dailySubtotalRows.push(excelRow);
      }
      if (groupedDailyData.grandTotal) {
        const gt = groupedDailyData.grandTotal;
        const gtRow = dailySheet.rowCount + 1;
        dailySheet.addRow(buildDailyRow(
          '合计', '', '', gt.request_count,
          gt.prompt_tokens, gt.cache_tokens, gt.completion_tokens, gt.total_tokens,
          gt.cost_usd, gt.cost_cny,
        ));
        dailySubtotalRows.push(gtRow);
      }
      applySheetBordersAndMerge(dailySheet, DAILY_COLS, 3, dateKeyMerges);
      for (const r of dailySubtotalRows) {
        for (let c = 1; c <= DAILY_COLS; c++) dailySheet.getCell(r, c).fill = subtotalFill;
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `token-usage-${activeTab}-${dayjs().format('YYYYMMDD-HHmmss')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Total cost — sum raw (unrounded) per-model values directly (not via subtotals).
  // Rounding is applied only once, at display time, so this matches the daily-detail
  // grand total exactly regardless of grouping granularity.
  const totalUSD = useMemo(() => byModel.reduce((s, r) => s + r.cost_usd, 0), [byModel]);
  const totalCNY = useMemo(() => byModel.reduce((s, r) => s + r.cost_cny, 0), [byModel]);

  const modelColumns: ColumnsType<ModelRow> = useMemo(() => ([
    { title: 'Key 名称', dataIndex: 'token_name', key: 'token_name', fixed: 'left', width: 160,
      onCell: (record) => ({ rowSpan: record.keyRowSpan }),
      render: (_v: string, record) => record.isGroupFirst ? <Tag>{record.token_name}</Tag> : null },
    { title: '模型', dataIndex: 'model_name', key: 'model_name', width: 220,
      render: (v: string) => <Text code>{v}</Text> },
    { title: '请求次数', dataIndex: 'request_count', key: 'request_count', align: 'right',
      sorter: () => 0,
      sortOrder: modelSortField === 'request_count' ? modelSortOrder : null,
      render: (v: number) => fmtCount(v) },
    { title: '输入 Tokens', dataIndex: 'prompt_tokens', key: 'prompt_tokens', align: 'right',
      sorter: () => 0,
      sortOrder: modelSortField === 'prompt_tokens' ? modelSortOrder : null,
      render: (v: number) => fmtTableToken(v) },
    { title: '缓存读 Tokens', dataIndex: 'cache_tokens', key: 'cache_tokens', align: 'right',
      sorter: () => 0,
      sortOrder: modelSortField === 'cache_tokens' ? modelSortOrder : null,
      render: (v: number) => v > 0 ? fmtTableToken(v) : <Text type="secondary">-</Text> },
    { title: '输出 Tokens', dataIndex: 'completion_tokens', key: 'completion_tokens', align: 'right',
      sorter: () => 0,
      sortOrder: modelSortField === 'completion_tokens' ? modelSortOrder : null,
      render: (v: number) => fmtTableToken(v) },
    { title: '总 Tokens', dataIndex: 'total_tokens', key: 'total_tokens', align: 'right',
      sorter: () => 0,
      sortOrder: modelSortField === 'total_tokens' ? modelSortOrder : null,
      render: (v: number) => <strong>{fmtTableToken(v)}</strong> },
    ...(calcCost && showUSD ? [{ title: '费用 (USD)', dataIndex: 'cost_usd', key: 'cost_usd', align: 'right' as const,
      sorter: () => 0,
      sortOrder: modelSortField === 'cost_usd' ? modelSortOrder : null,
      render: (v: number) => v > 0 ? <Tag color="green">{fmtUSDLocal(v)}</Tag> : <Text type="secondary">未配置</Text> }] : []),
    ...(calcCost ? [{ title: '费用 (CNY)', dataIndex: 'cost_cny', key: 'cost_cny', align: 'right' as const,
      sorter: () => 0,
      sortOrder: modelSortField === 'cost_cny' ? modelSortOrder : null,
      render: (v: number) => v > 0 ? <Tag color="blue">{fmtCNYLocal(v)}</Tag> : <Text type="secondary">未配置</Text> }] : []),
  ] as ColumnsType<ModelRow>), [fmtTableToken, fmtCount, fmtUSDLocal, fmtCNYLocal, modelSortField, modelSortOrder, calcCost, showUSD]);

  const dailyColumns: ColumnsType<DailyRow> = useMemo(() => ([
    { title: (
        <span
          style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
          onClick={() => setDailySortOrder(prev => prev === 'descend' ? 'ascend' : 'descend')}
        >
          日期 {dailySortOrder === 'ascend' ? '↑' : '↓'}
        </span>
      ),
      dataIndex: 'date', key: 'date', width: 130,
      onCell: (record) => ({ rowSpan: record.dateRowSpan }),
      render: (v: string) => v ? v.slice(0, 10) : '' },
    ...(dailyOnlyTotals ? [] : [{ title: 'Key 名称', dataIndex: 'token_name', key: 'token_name', width: 160,
      render: (v: string) => v ? <Tag>{v}</Tag> : null } as ColumnsType<DailyRow>[number]]),
    { title: dailyOnlyTotals ? '每日合计' : '模型', dataIndex: 'model_name', key: 'model_name', width: 220,
      render: (v: string, record) => (record.isDateSubtotal || dailyOnlyTotals) ? <strong>{v}</strong> : <Text code>{v}</Text> },
    { title: '请求次数', dataIndex: 'request_count', key: 'request_count', align: 'right',
      render: (v: number) => fmtCount(v) },
    { title: '输入 Tokens', dataIndex: 'prompt_tokens', key: 'prompt_tokens', align: 'right',
      render: (v: number) => fmtTableToken(v) },
    { title: '缓存读 Tokens', dataIndex: 'cache_tokens', key: 'cache_tokens', align: 'right',
      render: (v: number) => v > 0 ? fmtTableToken(v) : <Text type="secondary">-</Text> },
    { title: '输出 Tokens', dataIndex: 'completion_tokens', key: 'completion_tokens', align: 'right',
      render: (v: number) => fmtTableToken(v) },
    { title: '总 Tokens', dataIndex: 'total_tokens', key: 'total_tokens', align: 'right',
      render: (v: number) => <strong>{fmtTableToken(v)}</strong> },
    ...(calcCost && showUSD ? [{ title: '费用 (USD)', dataIndex: 'cost_usd', key: 'cost_usd', align: 'right' as const,
      render: (v: number) => v > 0 ? <Tag color="green">{fmtUSDLocal(v)}</Tag> : <Text type="secondary">-</Text> }] : []),
    ...(calcCost ? [{ title: '费用 (CNY)', dataIndex: 'cost_cny', key: 'cost_cny', align: 'right' as const,
      render: (v: number) => v > 0 ? <Tag color="blue">{fmtCNYLocal(v)}</Tag> : <Text type="secondary">-</Text> }] : []),
  ] as ColumnsType<DailyRow>), [fmtTableToken, fmtCount, fmtUSDLocal, fmtCNYLocal, dailySortOrder, calcCost, showUSD, dailyOnlyTotals]);

  const abnormalColumns: ColumnsType<AbnormalLog> = useMemo(() => ([
    { title: '时间', dataIndex: 'created_at', key: 'created_at', width: 170 },
    { title: 'Key 名称', dataIndex: 'token_name', key: 'token_name', width: 160,
      render: (v: string) => <Tag>{v}</Tag> },
    { title: '模型', dataIndex: 'model_name', key: 'model_name', width: 200,
      render: (v: string) => <Text code>{v}</Text> },
    { title: '输入 Tokens', dataIndex: 'prompt_tokens', key: 'prompt_tokens', align: 'right',
      render: (v: number) => fmtTableToken(v) },
    { title: '缓存读 Tokens', dataIndex: 'cache_tokens', key: 'cache_tokens', align: 'right',
      render: (v: number) => v > 0 ? fmtTableToken(v) : <Text type="secondary">-</Text> },
    { title: '输出 Tokens', dataIndex: 'completion_tokens', key: 'completion_tokens', align: 'right',
      render: (v: number) => fmtTableToken(v) },
    { title: '总 Tokens', dataIndex: 'total_tokens', key: 'total_tokens', align: 'right',
      render: (v: number) => <strong>{fmtTableToken(v)}</strong> },
    { title: '错误原因', dataIndex: 'error_reason', key: 'error_reason',
      render: (v: string) => <Text code style={{ whiteSpace: 'pre-wrap' }}>{v}</Text> },
  ] as ColumnsType<AbnormalLog>), [fmtTableToken]);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {/* Filter bar */}
      <Card size="small">
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {/* Row 1: Key Selection */}
          <Space wrap size="middle" align="center">
            <Text style={{ fontSize: 14, minWidth: 80 }}>选择 API Key：</Text>
            <Select
              mode="multiple"
              allowClear
              placeholder="不选则查询全部"
              style={{ minWidth: 400 }}
              value={selectedTokens}
              onChange={setSelectedTokens}
              options={tokenNames.map(n => ({ label: n, value: n }))}
              maxTagCount="responsive"
            />
          </Space>

          {/* Row 2: Time Selection */}
          <Space wrap size="middle" align="center">
            <Text style={{ fontSize: 14, minWidth: 80 }}>查询时间：</Text>
            <Segmented
              options={GRANULARITY_OPTIONS}
              value={granularity}
              onChange={v => setGranularity(v as Granularity)}
            />
            {granularity === 'custom' && (
              <RangePicker
                showTime
                format={DATETIME_FMT}
                value={customRange ? [customRange[0], customRange[1]] : null}
                onChange={v => setCustomRange(v ? [v[0]!, v[1]!] : null)}
                disabledDate={d => d.isAfter(dayjs())}
              />
            )}
            <Text type="secondary" style={{ fontSize: 12 }}>
              ({timeLabel})
            </Text>
          </Space>

          {/* Row 3: Query-condition buttons (need re-query to take effect) */}
          <Space wrap size="middle" align="center">
            <Text style={{ fontSize: 14, minWidth: 80 }}>
              查询条件
              <Tooltip title="修改后需重新点击「查询」生效" mouseEnterDelay={0} color="rgba(0,0,0,0.78)" overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px' }}>
                <InfoCircleOutlined style={{ marginLeft: 4, color: '#faad14', cursor: 'help' }} />
              </Tooltip>：
            </Text>
            <Tooltip
              title="开启后：排除流式请求中 frt < 0 的异常请求，不纳入统计"
              mouseEnterDelay={0}
              color="rgba(0,0,0,0.78)"
              overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px' }}
            >
              <Button
                type={excludeAbnormal ? 'primary' : 'default'}
                onClick={() => setExcludeAbnormal(v => !v)}
              >
                排除异常请求
              </Button>
            </Tooltip>
          </Space>

          {/* Row 4: Display setting buttons (instant effect) */}
          <Space wrap size="middle" align="center">
            <Text style={{ fontSize: 14, minWidth: 80 }}>
              显示设置
              <Tooltip title="即时生效，无需重新查询" mouseEnterDelay={0} color="rgba(0,0,0,0.78)" overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px' }}>
                <InfoCircleOutlined style={{ marginLeft: 4, color: '#8c8c8c', cursor: 'help' }} />
              </Tooltip>：
            </Text>
            <Tooltip
              title="将大数字以 K / M 等简写形式显示，便于阅读"
              mouseEnterDelay={0}
              color="rgba(0,0,0,0.78)"
              overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px' }}
            >
              <Button
                type={humanFriendly ? 'primary' : 'default'}
                icon={<NumberOutlined />}
                onClick={() => setHumanFriendly(h => !h)}
              >
                简化数字显示
              </Button>
            </Tooltip>
            <Tooltip
              title="对所有数值（含 K / M 简写数字）使用千分位分隔符显示，导出的 Excel 与页面格式保持一致"
              mouseEnterDelay={0}
              color="rgba(0,0,0,0.78)"
              overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px' }}
            >
              <Button
                type={thousandSep ? 'primary' : 'default'}
                onClick={() => setThousandSep(v => !v)}
              >
                千分位分隔
              </Button>
            </Tooltip>
            <Tooltip
              title="开启后：缓存读 Tokens 按配置的缓存价格单独计费，并从输入 Tokens 中扣除（适用 OpenAI 格式，避免双重计费）；关闭后：所有输入 Tokens 统一按输入价格计算。"
              mouseEnterDelay={0}
              color="rgba(0,0,0,0.78)"
              overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px', maxWidth: 360 }}
            >
              <Button
                type={useCachePrice ? 'primary' : 'default'}
                onClick={() => setUseCachePrice(v => !v)}
              >
                缓存读独立计费
              </Button>
            </Tooltip>
            <Tooltip
              title="每日明细页中显示每日小计和整体合计行"
              mouseEnterDelay={0}
              color="rgba(0,0,0,0.78)"
              overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px' }}
            >
              <Button
                type={showDailySubtotals ? 'primary' : 'default'}
                onClick={() => setShowDailySubtotals(v => !v)}
                disabled={dailyOnlyTotals}
              >
                每日小计/合计
              </Button>
            </Tooltip>
            <Tooltip
              title="每日明细页中只显示每日合计，不显示每个模型的明细"
              mouseEnterDelay={0}
              color="rgba(0,0,0,0.78)"
              overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px' }}
            >
              <Button
                type={dailyOnlyTotals ? 'primary' : 'default'}
                onClick={() => setDailyOnlyTotals(v => !v)}
              >
                仅显示每日合计
              </Button>
            </Tooltip>
            <Tooltip
              title="根据价格配置计算并显示费用列"
              mouseEnterDelay={0}
              color="rgba(0,0,0,0.78)"
              overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px' }}
            >
              <Button
                type={calcCost ? 'primary' : 'default'}
                onClick={() => setCalcCost(v => !v)}
              >
                是否计算费用
              </Button>
            </Tooltip>
            <Tooltip
              title="在费用列中同时显示美金（USD）"
              mouseEnterDelay={0}
              color="rgba(0,0,0,0.78)"
              overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px' }}
            >
              <Button
                type={showUSD ? 'primary' : 'default'}
                onClick={() => setShowUSD(v => !v)}
                disabled={!calcCost}
              >
                包含美金计算
              </Button>
            </Tooltip>
          </Space>

          {/* Row 5: Query button (separated) */}
          <div style={{ marginTop: 4, paddingTop: 12, borderTop: '1px solid #f0f0f0' }}>
            <Space size="middle" align="center">
              <Button type="primary" size="large" icon={<ReloadOutlined />} loading={loading} onClick={query}>
                查询
              </Button>
              <Button size="large" icon={<DownloadOutlined />} onClick={handleExport} disabled={!summary}>
                导出 Excel
              </Button>
            </Space>
          </div>
        </Space>
      </Card>

      {/* Summary cards */}
      {summary && (
        <Row gutter={16}>
          <Col span={4}>
            <Card size="small">
              <Statistic title="总请求数" value={summary.total_requests} formatter={v => fmtCount(Number(v))} />
            </Card>
          </Col>
          <Col span={5}>
            <Card size="small">
              <Statistic title="输入 Tokens" value={fmtSummaryToken(summary.total_prompt_tokens)} />
            </Card>
          </Col>
          <Col span={5}>
            <Card size="small">
              <Statistic title="输出 Tokens" value={fmtSummaryToken(summary.total_completion_tokens)} />
            </Card>
          </Col>
          <Col span={5}>
            <Card size="small">
              <Statistic title="总 Tokens" value={fmtSummaryToken(summary.total_tokens)} />
            </Card>
          </Col>
          {calcCost && (
            <Col span={5}>
              <Card size="small">
                <Statistic
                  title={showUSD ? '总费用 (USD / CNY)' : '总费用 (CNY)'}
                  value={calcCost ? (showUSD ? (totalUSD > 0 ? `${fmtUSDLocal(totalUSD)} / ${fmtCNYLocal(totalCNY)}` : '未配置价格') : (totalCNY > 0 ? fmtCNYLocal(totalCNY) : '未配置价格')) : '-'}
                  valueStyle={{ fontSize: 16 }}
                />
              </Card>
            </Col>
          )}
        </Row>
      )}

      {/* Data tables */}
      {summary && (
        <Card>
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              {
                key: 'model',
                label: '按模型汇总',
                children: (
                  <Table<ModelRow>
                    dataSource={groupedModelData.rows}
                    columns={modelColumns}
                    rowKey={(r, idx) => `${r.token_name}-${r.model_name}-${idx}`}
                    size="small"
                    scroll={{ x: 'max-content' }}
                    pagination={{ pageSize: 50, showSizeChanger: true, showTotal: t => `共 ${t} 条` }}
                    rowClassName={(record) => record.isSubtotal ? 'subtotal-row' : ''}
                    onChange={(_p, _f, sorter) => {
                      const s = Array.isArray(sorter) ? sorter[0] : sorter;
                      setModelSortField((s.field as keyof ModelCost) ?? '');
                      setModelSortOrder(s.order ?? null);
                    }}
                    summary={() => (
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0}><strong>合计</strong></Table.Summary.Cell>
                        <Table.Summary.Cell index={1} />
                        <Table.Summary.Cell index={2} align="right">
                          {fmtCount(summary.total_requests)}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={3} align="right">
                          {fmtTableToken(summary.total_prompt_tokens)}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={4} align="right">
                          {summary.total_cache_tokens > 0 ? fmtTableToken(summary.total_cache_tokens) : '-'}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={5} align="right">
                          {fmtTableToken(summary.total_completion_tokens)}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={6} align="right">
                          <strong>{fmtTableToken(summary.total_tokens)}</strong>
                        </Table.Summary.Cell>
                        {calcCost && showUSD && (
                          <Table.Summary.Cell index={7} align="right">
                            {totalUSD > 0 && <Tag color="green">{fmtUSDLocal(totalUSD)}</Tag>}
                          </Table.Summary.Cell>
                        )}
                        {calcCost && (
                          <Table.Summary.Cell index={8} align="right">
                            {totalCNY > 0 && <Tag color="blue">{fmtCNYLocal(totalCNY)}</Tag>}
                          </Table.Summary.Cell>
                        )}
                      </Table.Summary.Row>
                    )}
                  />
                ),
              },
              {
                key: 'daily',
                label: '每日明细',
                children: (
                  <Table<DailyRow>
                    dataSource={groupedDailyData.rows}
                    columns={dailyColumns}
                    rowKey={(_r, idx) => String(idx)}
                    size="small"
                    scroll={{ x: 'max-content' }}
                    pagination={{ pageSize: 100, showSizeChanger: true, showTotal: t => `共 ${t} 条` }}
                    rowClassName={(record) => record.isDateSubtotal ? 'subtotal-row' : ''}
                    summary={() => (showDailySubtotals || dailyOnlyTotals) && groupedDailyData.grandTotal ? (
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0}><strong>合计</strong></Table.Summary.Cell>
                        {!dailyOnlyTotals && <Table.Summary.Cell index={1} />}
                        <Table.Summary.Cell index={2} />
                        <Table.Summary.Cell index={3} align="right">
                          {fmtCount(groupedDailyData.grandTotal.request_count)}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={4} align="right">
                          {fmtTableToken(groupedDailyData.grandTotal.prompt_tokens)}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={5} align="right">
                          {groupedDailyData.grandTotal.cache_tokens > 0 ? fmtTableToken(groupedDailyData.grandTotal.cache_tokens) : '-'}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={6} align="right">
                          {fmtTableToken(groupedDailyData.grandTotal.completion_tokens)}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={7} align="right">
                          <strong>{fmtTableToken(groupedDailyData.grandTotal.total_tokens)}</strong>
                        </Table.Summary.Cell>
                        {calcCost && showUSD && (
                          <Table.Summary.Cell index={8} align="right">
                            {groupedDailyData.grandTotal.cost_usd > 0 && <Tag color="green">{fmtUSDLocal(groupedDailyData.grandTotal.cost_usd)}</Tag>}
                          </Table.Summary.Cell>
                        )}
                        {calcCost && (
                          <Table.Summary.Cell index={9} align="right">
                            {groupedDailyData.grandTotal.cost_cny > 0 && <Tag color="blue">{fmtCNYLocal(groupedDailyData.grandTotal.cost_cny)}</Tag>}
                          </Table.Summary.Cell>
                        )}
                      </Table.Summary.Row>
                    ) : null}
                  />
                ),
              },
              {
                key: 'abnormal',
                label: (
                  <span>
                    异常请求明细{abnormalLogs.length ? ` (${abnormalLogs.length})` : ''}
                    <Tooltip
                      title="判定条件：流式请求中首字响应时间（frt）< 0 的请求视为异常，不纳入正常统计"
                      mouseEnterDelay={0}
                      color="rgba(0,0,0,0.78)"
                      overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px', maxWidth: 300 }}
                    >
                      <InfoCircleOutlined style={{ marginLeft: 6, color: '#faad14', cursor: 'help' }} />
                    </Tooltip>
                  </span>
                ),
                children: (
                  <Table<AbnormalLog>
                    dataSource={abnormalLogs}
                    columns={abnormalColumns}
                    rowKey={(_r, idx) => String(idx)}
                    size="small"
                    scroll={{ x: 'max-content' }}
                    pagination={{ pageSize: 50, showSizeChanger: true, showTotal: t => `共 ${t} 条` }}
                  />
                ),
              },
            ]}
          />
        </Card>
      )}
      <style>{`
        .subtotal-row {
          background-color: #E3F2FD !important;
        }
        .subtotal-row:hover > td {
          background-color: #BBDEFB !important;
        }
      `}</style>
    </Space>
  );
}
