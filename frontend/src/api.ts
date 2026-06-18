import axios from 'axios';
import { DailyCost, PriceConfig, SummaryResponse } from './types';

const BASE = '';

export interface QueryParams {
  token_names?: string[];
  start?: number;
  end?: number;
  granularity?: string;
  human_friendly?: boolean;
  use_cache_price?: boolean;
}

function buildParams(p: QueryParams): Record<string, string> {
  const params: Record<string, string> = {};
  if (p.token_names?.length) params.token_names = p.token_names.join(',');
  if (p.start) params.start = String(p.start);
  if (p.end) params.end = String(p.end);
  if (p.granularity) params.granularity = p.granularity;
  if (p.human_friendly) params.human_friendly = '1';
  if (p.use_cache_price) params.use_cache_price = '1';
  return params;
}

export async function fetchTokenNames(): Promise<string[]> {
  const res = await axios.get(`${BASE}/api/tokens`);
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
