import { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, DatePicker, message, Segmented, Select, Space, Table, Tag, Tooltip, Typography,
} from 'antd';
import { DownloadOutlined, InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { Dayjs } from 'dayjs';
import { buildExportRequestsUrl, fetchModelNames, fetchRequestLogs, fetchTokenNames, QueryParams } from '../api';
import type { RequestLog } from '../types';

const { RangePicker } = DatePicker;
const { Text } = Typography;

const DATETIME_FMT = 'YYYY-MM-DD HH:mm:ss';

type Granularity = 'today' | 'week' | 'month' | 'last30' | 'all' | 'custom';

const GRANULARITY_OPTIONS: { label: string; value: Granularity }[] = [
  { label: '今日', value: 'today' },
  { label: '本周', value: 'week' },
  { label: '本月', value: 'month' },
  { label: '近30天', value: 'last30' },
  { label: '所有时间', value: 'all' },
  { label: '自定义', value: 'custom' },
];

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

function fmtCount(n: number): string {
  return n.toLocaleString();
}

export default function Requests() {
  const [tokenNames, setTokenNames] = useState<string[]>([]);
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const [modelNames, setModelNames] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [granularity, setGranularity] = useState<Granularity>('today');
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [hasQueried, setHasQueried] = useState(false);
  const [total, setTotal] = useState(0);
  const [totalCostCNY, setTotalCostCNY] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sheetRows, setSheetRows] = useState(1000000);
  const [useCachePrice, setUseCachePrice] = useState(true);
  const [thousandSep, setThousandSep] = useState(true);
  const [showStatusCode, setShowStatusCode] = useState(true);

  useEffect(() => {
    fetchTokenNames()
      .then(setTokenNames)
      .catch(() => message.error('加载 Token 列表失败'));
    fetchModelNames()
      .then(setModelNames)
      .catch(() => message.error('加载模型列表失败'));
  }, []);

  const timeRange = computeTimeRange(granularity, customRange);
  const timeLabel = timeRangeLabel(timeRange);

  const buildQueryParams = useCallback((): QueryParams => {
    const p: QueryParams = { token_names: selectedTokens, model_names: selectedModels };
    if (granularity !== 'custom') {
      p.granularity = granularity;
    } else if (customRange) {
      p.start = customRange[0].unix();
      p.end = customRange[1].unix();
    }
    return p;
  }, [selectedTokens, selectedModels, granularity, customRange]);

  const doQuery = useCallback(async (targetPage: number, targetPageSize: number) => {
    setLoading(true);
    try {
      const res = await fetchRequestLogs({
        ...buildQueryParams(),
        use_cache_price: useCachePrice,
        page: targetPage,
        page_size: targetPageSize,
      });
      setLogs(res.data ?? []);
      setTotal(res.total);
      setTotalCostCNY(res.total_cost_cny ?? 0);
      setHasQueried(true);
    } catch (e: unknown) {
      message.error('查询失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [buildQueryParams]);

  const handleQuery = () => {
    setPage(1);
    setPageSize(pageSize);
    void doQuery(1, pageSize);
  };

  const handleTableChange = (p: number, ps: number) => {
    setPage(p);
    setPageSize(ps);
    void doQuery(p, ps);
  };

  const handleExport = () => {
    window.open(buildExportRequestsUrl({ ...buildQueryParams(), use_cache_price: useCachePrice, thousand_sep: thousandSep, hide_status_code: !showStatusCode }, sheetRows), '_blank');
  };

  const columns: ColumnsType<RequestLog> = [
    { title: '时间', dataIndex: 'created_at', key: 'created_at', width: 170 },
    { title: 'Key 名称', dataIndex: 'token_name', key: 'token_name', width: 140,
      render: (v: string) => <Tag>{v}</Tag> },
    { title: '模型', dataIndex: 'model_name', key: 'model_name', width: 200,
      render: (v: string) => <Text code>{v}</Text> },
    { title: '耗时(秒)', dataIndex: 'use_time', key: 'use_time', align: 'right', width: 100,
      render: (v: number) => fmtCount(v) },
    { title: '流式', dataIndex: 'is_stream', key: 'is_stream', width: 80,
      render: (v: boolean) => v ? <Tag color="blue">是</Tag> : <Tag>否</Tag> },
    { title: (
        <span>
          TTFT(ms)
          <Tooltip
            title="流式请求的首字响应时间；非流式请求显示 -"
            mouseEnterDelay={0.2}
            color="rgba(0,0,0,0.78)"
            overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px' }}
          >
            <InfoCircleOutlined style={{ marginLeft: 4, color: '#8c8c8c', cursor: 'help' }} />
          </Tooltip>
        </span>
      ),
      key: 'ttft', align: 'right', width: 110,
      render: (_v: unknown, record) => (record.is_stream && record.frt >= 0) ? fmtCount(record.frt) : <Text type="secondary">-</Text> },
    { title: '输入 Tokens', dataIndex: 'prompt_tokens', key: 'prompt_tokens', align: 'right',
      render: (v: number) => fmtCount(v) },
    { title: '缓存命中 Tokens', dataIndex: 'cache_tokens', key: 'cache_tokens', align: 'right',
      render: (v: number) => v > 0 ? fmtCount(v) : <Text type="secondary">-</Text> },
    { title: '输出 Tokens', dataIndex: 'completion_tokens', key: 'completion_tokens', align: 'right',
      render: (v: number) => fmtCount(v) },
    { title: '总 Tokens', dataIndex: 'total_tokens', key: 'total_tokens', align: 'right',
      render: (v: number) => <strong>{fmtCount(v)}</strong> },
    ...(showStatusCode ? [{
      title: '状态码', dataIndex: 'status_code', key: 'status_code', width: 90,
      render: (v: number) => v === 200 ? <Tag color="green">{v}</Tag> : <Tag color="red">{v}</Tag>,
    } as ColumnsType<RequestLog>[number]] : []),
    { title: '费用 (CNY)', dataIndex: 'cost_cny', key: 'cost_cny', align: 'right', width: 120,
      render: (v: number) => v > 0 ? <Tag color="blue">¥{v.toFixed(4)}</Tag> : <Text type="secondary">-</Text> },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {/* Filter bar */}
      <Card size="small">
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
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

          <Space wrap size="middle" align="center">
            <Text style={{ fontSize: 14, minWidth: 80 }}>选择模型：</Text>
            <Select
              mode="multiple"
              allowClear
              placeholder="不选则查询全部"
              style={{ minWidth: 400 }}
              value={selectedModels}
              onChange={setSelectedModels}
              options={modelNames.map(m => ({ label: m, value: m }))}
              maxTagCount="responsive"
            />
          </Space>

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

          {/* Row 4: Display settings (instant effect, no re-query) */}
          <Space wrap size="middle" align="center">
            <Text style={{ fontSize: 14, minWidth: 80 }}>
              显示设置
              <Tooltip title="即时生效，无需重新查询" mouseEnterDelay={0} color="rgba(0,0,0,0.78)" overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px' }}>
                <InfoCircleOutlined style={{ marginLeft: 4, color: '#8c8c8c', cursor: 'help' }} />
              </Tooltip>：
            </Text>
            <Tooltip
              title="开启后：导出汇总中的缓存读 Tokens 按配置的缓存价格单独计费，并从输入 Tokens 中扣除（适用 OpenAI 格式，避免双重计费）；关闭后：所有输入 Tokens 统一按输入价格计算。与「用量统计」页保持一致"
              mouseEnterDelay={0.2}
              color="rgba(0,0,0,0.78)"
              overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px', maxWidth: 380 }}
            >
              <Button
                type={useCachePrice ? 'primary' : 'default'}
                onClick={() => setUseCachePrice(v => !v)}
              >
                缓存读独立计费
              </Button>
            </Tooltip>
            <Tooltip
              title="导出的 Excel 中数值列使用千分位（英文逗号）分隔显示，如 1,821,440,552；数值仍为数字类型，可正常排序、求和"
              mouseEnterDelay={0.2}
              color="rgba(0,0,0,0.78)"
              overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px', maxWidth: 380 }}
            >
              <Button
                type={thousandSep ? 'primary' : 'default'}
                onClick={() => setThousandSep(v => !v)}
              >
                千分位分隔
              </Button>
            </Tooltip>
            <Tooltip
              title="页面表格和导出的 Excel 中显示「状态码」列（200 以外的状态码标红）"
              mouseEnterDelay={0.2}
              color="rgba(0,0,0,0.78)"
              overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px', maxWidth: 380 }}
            >
              <Button
                type={showStatusCode ? 'primary' : 'default'}
                onClick={() => setShowStatusCode(v => !v)}
              >
                显示状态码
              </Button>
            </Tooltip>
          </Space>

          {/* Row 5: Query / export actions (separated) */}
          <div style={{ marginTop: 4, paddingTop: 12, borderTop: '1px solid #f0f0f0' }}>
            <Space size="middle" align="center" wrap>
              <Button type="primary" size="large" icon={<ReloadOutlined />} loading={loading} onClick={handleQuery}>
                查询
              </Button>
              <Text style={{ fontSize: 14 }}>每Sheet行数：</Text>
              <Tooltip
                title="导出时每个 Sheet 的最大数据行数；数据量超过该值时自动分成多个 Sheet（Excel 单表硬上限约 104 万行）"
                mouseEnterDelay={0.2}
                color="rgba(0,0,0,0.78)"
                overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px', maxWidth: 320 }}
              >
                <Select
                  size="large"
                  style={{ width: 120 }}
                  value={sheetRows}
                  onChange={setSheetRows}
                  options={[
                    { label: '100万条', value: 1000000 },
                    { label: '50万条', value: 500000 },
                    { label: '20万条', value: 200000 },
                    { label: '10万条', value: 100000 },
                  ]}
                />
              </Tooltip>
              <Tooltip
                title="按当前筛选条件导出全部请求明细为 Excel，第一个 Sheet 为汇总（含总输入/输出/缓存 Tokens、请求数量、总费用），其后为请求明细（大时间范围导出可能较慢）"
                mouseEnterDelay={0.2}
                color="rgba(0,0,0,0.78)"
                overlayInnerStyle={{ borderRadius: 6, fontSize: 13, padding: '8px 12px', maxWidth: 380 }}
              >
                <Button size="large" icon={<DownloadOutlined />} onClick={handleExport}>
                  导出 Excel
                </Button>
              </Tooltip>
            </Space>
          </div>
        </Space>
      </Card>

      {/* Data table */}
      <Card>
        {hasQueried && (
          <div style={{ marginBottom: 12 }}>
            <Space size="large" align="center">
              <Text strong>总费用（人民币）：</Text>
              {totalCostCNY > 0
                ? <Tag color="blue" style={{ fontSize: 14 }}>¥{totalCostCNY.toFixed(4)}</Tag>
                : <Text type="secondary">未配置价格</Text>}
              <Text type="secondary" style={{ fontSize: 12 }}>
                （当前筛选条件下全部匹配请求的费用合计）
              </Text>
            </Space>
          </div>
        )}
        <Table<RequestLog>
          dataSource={logs}
          columns={columns}
          rowKey={(r, idx) => `${r.created_at}-${idx}`}
          size="small"
          scroll={{ x: 'max-content' }}
          loading={loading}
          locale={{ emptyText: hasQueried ? '暂无数据' : '请设置筛选条件后点击「查询」' }}
          pagination={hasQueried ? {
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: t => `共 ${t.toLocaleString()} 条`,
            onChange: handleTableChange,
          } : false}
        />
      </Card>
    </Space>
  );
}
