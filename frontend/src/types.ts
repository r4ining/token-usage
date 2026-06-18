export interface ModelStat {
  token_name: string;
  model_name: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_tokens: number;
  total_tokens: number;
  quota: number;
  request_count: number;
}

export interface ModelCost extends ModelStat {
  cost_usd: number;
  cost_cny: number;
}

export interface DailyStat {
  date: string;
  token_name: string;
  model_name: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_tokens: number;
  total_tokens: number;
  quota: number;
  request_count: number;
}

export interface DailyCost extends DailyStat {
  cost_usd: number;
  cost_cny: number;
}

export interface SummaryResult {
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cache_tokens: number;
  total_tokens: number;
  total_quota: number;
  total_requests: number;
  by_model: ModelStat[];
}

export interface SummaryResponse {
  summary: SummaryResult;
  by_model: ModelCost[];
}

export interface PriceEntry {
  id: string;
  model_id: string;
  aliases: string[];
  input_price: number;
  output_price: number;
  cache_price: number;
  currency?: string; // "USD" or "CNY" - for frontend display
}

export interface PriceConfig {
  entries: PriceEntry[];
  usd_to_cny: number;
}
