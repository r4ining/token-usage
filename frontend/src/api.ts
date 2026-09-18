import axios from 'axios';
import { AbnormalLog, DailyCost, PriceConfig, RequestLogsResponse, SummaryResponse } from './types';

const BASE = '';

export interface QueryParams {
  token_names?: string[];
  model_names?: string[];
  start?: number;
  end?: number;
  granularity?: string;
  human_friendly?: boolean;
  use_cache_price?: boolean;
  exclude_abnormal?: boolean;
  thousand_sep?: boolean;
  hide_status_code?: boolean;
}

export interface RequestLogQueryParams extends QueryParams {
  page?: number;
  page_size?: number;
}

function buildParams(p: QueryParams): Record<string, string> {
  const params: Record<string, string> = {};
  if (p.token_names?.length) params.token_names = p.token_names.join(',');
  if (p.model_names?.length) params.model_names = p.model_names.join(',');
  if (p.start) params.start = String(p.start);
  if (p.end) params.end = String(p.end);
  if (p.granularity) params.granularity = p.granularity;
  if (p.human_friendly) params.human_friendly = '1';
  if (p.use_cache_price) params.use_cache_price = '1';
  if (p.exclude_abnormal) params.exclude_abnormal = '1';
  if (p.thousand_sep) params.thousand_sep = '1';
  if (p.hide_status_code) params.hide_status_code = '1';
  return params;
}

export async function fetchTokenNames(): Promise<string[]> {
  const res = await axios.get(`${BASE}/api/tokens`);
  return res.data.data ?? [];
}

export async function fetchModelNames(): Promise<string[]> {
  const res = await axios.get(`${BASE}/api/models`);
  return res.data.data ?? [];
}

export async function fetchSummary(p: QueryParams): Promise<SummaryResponse> {
  const res = await axios.get(`${BASE}/api/stats/summary`, { params: buildParams(p) });
  return res.data;
}

export async function fetchDaily(p: QueryParams): Promise<DailyCost[]> {
  const res = await axios.get(`${BASE}/api/stats/daily`, { params: buildParams(p) });
  return res.data.data ?? [];
}

export async function fetchAbnormal(p: QueryParams): Promise<AbnormalLog[]> {
  const res = await axios.get(`${BASE}/api/stats/abnormal`, { params: buildParams(p) });
  return res.data.data ?? [];
}

export async function fetchRequestLogs(p: RequestLogQueryParams): Promise<RequestLogsResponse> {
  const params = buildParams(p);
  if (p.page) params.page = String(p.page);
  if (p.page_size) params.page_size = String(p.page_size);
  const res = await axios.get(`${BASE}/api/stats/requests`, { params });
  return res.data;
}

export async function fetchPrices(): Promise<PriceConfig> {
  const res = await axios.get(`${BASE}/api/prices`);
  return res.data;
}

export async function savePrices(cfg: PriceConfig): Promise<void> {
  await axios.post(`${BASE}/api/prices`, cfg);
}

export function buildExportUrl(p: QueryParams): string {
  const params = new URLSearchParams(buildParams(p));
  return `${BASE}/api/export?${params.toString()}`;
}

export function buildExportAbnormalUrl(p: QueryParams): string {
  const params = new URLSearchParams(buildParams(p));
  return `${BASE}/api/export/abnormal?${params.toString()}`;
}

export function buildExportRequestsUrl(p: QueryParams, sheetRows?: number): string {
  const params = new URLSearchParams(buildParams(p));
  if (sheetRows) params.set('sheet_rows', String(sheetRows));
  return `${BASE}/api/export/requests?${params.toString()}`;
}
