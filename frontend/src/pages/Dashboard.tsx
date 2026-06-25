import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Col, DatePicker, message, Row, Select, Space,
  Statistic, Table, Tabs, Tag, Typography, Segmented,
} from 'antd';
import { DownloadOutlined, NumberOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { SortOrder } from 'antd/es/table/interface';
import dayjs, { Dayjs } from 'dayjs';
import ExcelJS from 'exceljs';
import { fetchDaily, fetchPrices, fetchSummary, fetchTokenNames, QueryParams } from '../api';
import type { DailyCost, DailyStat, ModelCost, ModelStat, PriceConfig, PriceEntry, SummaryResult } from '../types';

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

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtHuman(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(3) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(3) + 'K';
  return String(n);
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

function fmtUSD(n: number): string {
  return '$' + n.toFixed(4);
}

function fmtCNY(n: number): string {
  return '¥' + n.toFixed(4);
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
  const [activeTab, setActiveTab] = useState('model');
  const [humanFriendly, setHumanFriendly] = useState(true);
  const [useCachePrice, setUseCachePrice] = useState(true);
  const [modelSortField, setModelSortField] = useState<keyof ModelCost | ''>('');
  const [modelSortOrder, setModelSortOrder] = useState<SortOrder>(null);
  const [showDailySubtotals, setShowDailySubtotals] = useState(true);
  const [dailySortOrder, setDailySortOrder] = useState<SortOrder>('ascend');

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

  const fmtTableToken = useCallback((n: number) => humanFriendly ? fmtHuman(n) : n.toLocaleString(), [humanFriendly]);
  const fmtSummaryToken = useCallback((n: number) => humanFriendly ? fmtHuman(n) : fmtNum(n), [humanFriendly]);

  // Group byModel data by token_name with subtotals
  const groupedModelData = useMemo(() => {
    if (!byModel.length) return { rows: [] as ModelRow[], subtotals: [] as { tokenName: string; data: ModelCost }[] };
    
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
        subtotal.cost_usd += Math.round(item.cost_usd * 10000) / 10000;
        subtotal.cost_cny += Math.round(item.cost_cny * 10000) / 10000;
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
    
    return { rows, subtotals };
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
        subtotal.cost_usd += Math.round(item.cost_usd * 10000) / 10000;
        subtotal.cost_cny += Math.round(item.cost_cny * 10000) / 10000;
        grandTotal.prompt_tokens += item.prompt_tokens;
        grandTotal.completion_tokens += item.completion_tokens;
        grandTotal.cache_tokens += item.cache_tokens;
        grandTotal.total_tokens += item.total_tokens;
        grandTotal.quota += item.quota;
        grandTotal.request_count += item.request_count;
        grandTotal.cost_usd += Math.round(item.cost_usd * 10000) / 10000;
        grandTotal.cost_cny += Math.round(item.cost_cny * 10000) / 10000;
      }
      const groupSize = showDailySubtotals ? items.length + 1 : items.length;
      items.forEach((item, idx) => {
        rows.push({ ...item, dateRowSpan: idx === 0 ? groupSize : 0, isDateFirst: idx === 0 });
      });
      if (showDailySubtotals) {
        rows.push({ ...subtotal, isDateSubtotal: true, dateRowSpan: 0, isDateFirst: false });
      }
    }
    return { rows, grandTotal };
  }, [daily, showDailySubtotals, dailySortOrder]);

  const buildQueryParams = useCallback((): QueryParams => {
    const p: QueryParams = { token_names: selectedTokens };
    if (granularity !== 'custom') {
      p.granularity = granularity;
    } else if (customRange) {
      p.start = customRange[0].unix();
      p.end = customRange[1].unix();
    }
    return p;
  }, [selectedTokens, granularity, customRange]);

  const query = useCallback(async () => {
    setLoading(true);
    try {
      const p = buildQueryParams();
      const [summaryRes, dailyRes, pc] = await Promise.all([
        fetchSummary(p),
        fetchDaily(p),
        fetchPrices(),
      ]);
      setPriceConfig(pc);
      setSummary(summaryRes.summary);
      setRawByModel(summaryRes.summary.by_model);
      setRawDaily(dailyRes);
    } catch (e: unknown) {
      message.error('查询失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [buildQueryParams]);

  const handleExport = async () => {
    const fmtTok = (n: number) => humanFriendly ? fmtHuman(n) : n;

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
      // Re-apply border to merged cells (mergeCells resets style)
      for (let r = 1; r <= totalRows; r++) {
        for (let c = 1; c <= totalCols; c++) {
          const cell = ws.getCell(r, c);
          cell.border = allBorders;
        }
      }
      void dataStartRow;
    }

    const subtotalFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFE3F2FD' } };

    const wb = new ExcelJS.Workbook();

    if (activeTab === 'model') {
      // ── 按模型汇总 ──
      const summarySheet = wb.addWorksheet('模型汇总');
      const SUMMARY_COLS = 9;
      summarySheet.addRow([`查询时间区间：${timeLabel}`]);
      summarySheet.addRow(['Key名称', '模型', '请求次数', '输入Tokens', '缓存读Tokens', '输出Tokens', '总Tokens', '费用(USD)', '费用(CNY)']);

      const summaryKeyMerges: { startRow: number; endRow: number }[] = [];
      const summarySubtotalRows: number[] = [];
      for (const row of groupedModelData.rows) {
        const excelRow = summarySheet.rowCount + 1;
        summarySheet.addRow([
          row.token_name, row.model_name, row.request_count,
          fmtTok(row.prompt_tokens), fmtTok(row.cache_tokens), fmtTok(row.completion_tokens),
          fmtTok(row.total_tokens),
          row.cost_usd > 0 ? (Math.round(row.cost_usd * 10000) / 10000).toFixed(4) : '',
          row.cost_cny > 0 ? (Math.round(row.cost_cny * 10000) / 10000).toFixed(4) : '',
        ]);
        if (row.keyRowSpan > 1) {
          summaryKeyMerges.push({ startRow: excelRow, endRow: excelRow + row.keyRowSpan - 1 });
        }
        if (row.isSubtotal) summarySubtotalRows.push(excelRow);
      }
      applySheetBordersAndMerge(summarySheet, SUMMARY_COLS, 3, summaryKeyMerges);
      for (const r of summarySubtotalRows) {
        for (let c = 1; c <= SUMMARY_COLS; c++) summarySheet.getCell(r, c).fill = subtotalFill;
      }
    } else {
      // ── 每日明细 ──
      const dailySheet = wb.addWorksheet('每日明细');
      const DAILY_COLS = 10;
      dailySheet.addRow([`查询时间区间：${timeLabel}`]);
      dailySheet.addRow(['日期', 'Key名称', '模型', '请求次数', '输入Tokens', '缓存读Tokens', '输出Tokens', '总Tokens', '费用(USD)', '费用(CNY)']);

      const dateKeyMerges: { startRow: number; endRow: number }[] = [];
      const dailySubtotalRows: number[] = [];
      for (const row of groupedDailyData.rows) {
        const excelRow = dailySheet.rowCount + 1;
        dailySheet.addRow([
          row.date.slice(0, 10), row.token_name, row.model_name, row.request_count,
          fmtTok(row.prompt_tokens), fmtTok(row.cache_tokens), fmtTok(row.completion_tokens),
          fmtTok(row.total_tokens),
          row.cost_usd > 0 ? (Math.round(row.cost_usd * 10000) / 10000).toFixed(4) : '',
          row.cost_cny > 0 ? (Math.round(row.cost_cny * 10000) / 10000).toFixed(4) : '',
        ]);
        if (row.dateRowSpan > 1) {
          dateKeyMerges.push({ startRow: excelRow, endRow: excelRow + row.dateRowSpan - 1 });
        }
        if (row.isDateSubtotal) dailySubtotalRows.push(excelRow);
      }
      if (groupedDailyData.grandTotal) {
        const gt = groupedDailyData.grandTotal;
        const gtRow = dailySheet.rowCount + 1;
        dailySheet.addRow([
          '合计', '', '', gt.request_count,
          fmtTok(gt.prompt_tokens), fmtTok(gt.cache_tokens), fmtTok(gt.completion_tokens),
          fmtTok(gt.total_tokens),
          gt.cost_usd > 0 ? (Math.round(gt.cost_usd * 10000) / 10000).toFixed(4) : '',
          gt.cost_cny > 0 ? (Math.round(gt.cost_cny * 10000) / 10000).toFixed(4) : '',
        ]);
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

  // Total cost — sum rounded per-model values directly (not via subtotals)
  const totalUSD = useMemo(() => byModel.reduce((s, r) => s + Math.round(r.cost_usd * 10000) / 10000, 0), [byModel]);
  const totalCNY = useMemo(() => byModel.reduce((s, r) => s + Math.round(r.cost_cny * 10000) / 10000, 0), [byModel]);

  const modelColumns: ColumnsType<ModelRow> = useMemo(() => [
    { title: 'Key 名称', dataIndex: 'token_name', key: 'token_name', fixed: 'left', width: 160,
      onCell: (record) => ({ rowSpan: record.keyRowSpan }),
      render: (_v: string, record) => record.isGroupFirst ? <Tag>{record.token_name}</Tag> : null },
    { title: '模型', dataIndex: 'model_name', key: 'model_name', width: 220,
      render: (v: string) => <Text code>{v}</Text> },
    { title: '请求次数', dataIndex: 'request_count', key: 'request_count', align: 'right',
      sorter: () => 0,
      sortOrder: modelSortField === 'request_count' ? modelSortOrder : null,
      render: (v: number) => v.toLocaleString() },
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
    { title: '费用 (USD)', dataIndex: 'cost_usd', key: 'cost_usd', align: 'right',
      sorter: () => 0,
      sortOrder: modelSortField === 'cost_usd' ? modelSortOrder : null,
      render: (v: number) => v > 0 ? <Tag color="green">{fmtUSD(v)}</Tag> : <Text type="secondary">未配置</Text> },
    { title: '费用 (CNY)', dataIndex: 'cost_cny', key: 'cost_cny', align: 'right',
      sorter: () => 0,
      sortOrder: modelSortField === 'cost_cny' ? modelSortOrder : null,
      render: (v: number) => v > 0 ? <Tag color="blue">{fmtCNY(v)}</Tag> : <Text type="secondary">未配置</Text> },
  ], [fmtTableToken, modelSortField, modelSortOrder]);

  const dailyColumns: ColumnsType<DailyRow> = useMemo(() => [
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
    { title: 'Key 名称', dataIndex: 'token_name', key: 'token_name', width: 160,
      render: (v: string) => v ? <Tag>{v}</Tag> : null },
    { title: '模型', dataIndex: 'model_name', key: 'model_name', width: 220,
      render: (v: string, record) => record.isDateSubtotal ? <strong>{v}</strong> : <Text code>{v}</Text> },
    { title: '请求次数', dataIndex: 'request_count', key: 'request_count', align: 'right',
      render: (v: number) => v.toLocaleString() },
    { title: '输入 Tokens', dataIndex: 'prompt_tokens', key: 'prompt_tokens', align: 'right',
      render: (v: number) => fmtTableToken(v) },
    { title: '缓存读 Tokens', dataIndex: 'cache_tokens', key: 'cache_tokens', align: 'right',
      render: (v: number) => v > 0 ? fmtTableToken(v) : <Text type="secondary">-</Text> },
    { title: '输出 Tokens', dataIndex: 'completion_tokens', key: 'completion_tokens', align: 'right',
      render: (v: number) => fmtTableToken(v) },
    { title: '总 Tokens', dataIndex: 'total_tokens', key: 'total_tokens', align: 'right',
      render: (v: number) => <strong>{fmtTableToken(v)}</strong> },
    { title: '费用 (USD)', dataIndex: 'cost_usd', key: 'cost_usd', align: 'right',
      render: (v: number) => v > 0 ? <Tag color="green">{fmtUSD(v)}</Tag> : <Text type="secondary">-</Text> },
    { title: '费用 (CNY)', dataIndex: 'cost_cny', key: 'cost_cny', align: 'right',
      render: (v: number) => v > 0 ? <Tag color="blue">{fmtCNY(v)}</Tag> : <Text type="secondary">-</Text> },
  ], [fmtTableToken, dailySortOrder]);

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

          {/* Row 3: Action Buttons */}
          <Space wrap size="middle" align="center">
            <Text style={{ fontSize: 14, minWidth: 80 }}>操作：</Text>
            <Button type="primary" icon={<ReloadOutlined />} loading={loading} onClick={query}>
              查询
            </Button>
            <Button icon={<DownloadOutlined />} onClick={handleExport} disabled={!summary}>
              导出 Excel
            </Button>
            <Button
              type={humanFriendly ? 'primary' : 'default'}
              icon={<NumberOutlined />}
              onClick={() => setHumanFriendly(h => !h)}
            >
              简化数字显示
            </Button>
            <Button
              type={useCachePrice ? 'primary' : 'default'}
              onClick={() => setUseCachePrice(v => !v)}
              title="开启后：缓存读 Tokens 按配置的缓存价格单独计费，并从输入 Tokens 中扣除（适用 OpenAI 格式，避免双重计费）；关闭后：所有输入 Tokens 统一按输入价格计算。"
            >
              缓存读独立计费
            </Button>
            <Button
              type={showDailySubtotals ? 'primary' : 'default'}
              onClick={() => setShowDailySubtotals(v => !v)}
              title="每日明细页中是否显示每日小计和整体合计行"
            >
              每日小计/合计
            </Button>
          </Space>
        </Space>
      </Card>

      {/* Summary cards */}
      {summary && (
        <Row gutter={16}>
          <Col span={4}>
            <Card size="small">
              <Statistic title="总请求数" value={summary.total_requests} formatter={v => Number(v).toLocaleString()} />
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
          <Col span={5}>
            <Card size="small">
              <Statistic
                title="总费用 (USD / CNY)"
                value={totalUSD > 0 ? `${fmtUSD(totalUSD)} / ${fmtCNY(totalCNY)}` : '未配置价格'}
                valueStyle={{ fontSize: 16 }}
              />
            </Card>
          </Col>
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
                          {summary.total_requests.toLocaleString()}
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
                        <Table.Summary.Cell index={7} align="right">
                          {totalUSD > 0 && <Tag color="green">{fmtUSD(totalUSD)}</Tag>}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={8} align="right">
                          {totalCNY > 0 && <Tag color="blue">{fmtCNY(totalCNY)}</Tag>}
                        </Table.Summary.Cell>
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
                    summary={() => showDailySubtotals && groupedDailyData.grandTotal ? (
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0}><strong>合计</strong></Table.Summary.Cell>
                        <Table.Summary.Cell index={1} />
                        <Table.Summary.Cell index={2} />
                        <Table.Summary.Cell index={3} align="right">
                          {groupedDailyData.grandTotal.request_count.toLocaleString()}
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
                        <Table.Summary.Cell index={8} align="right">
                          {groupedDailyData.grandTotal.cost_usd > 0 && <Tag color="green">{fmtUSD(groupedDailyData.grandTotal.cost_usd)}</Tag>}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={9} align="right">
                          {groupedDailyData.grandTotal.cost_cny > 0 && <Tag color="blue">{fmtCNY(groupedDailyData.grandTotal.cost_cny)}</Tag>}
                        </Table.Summary.Cell>
                      </Table.Summary.Row>
                    ) : null}
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
