export interface UsageLimit {
  utilization: number;    // 0–100 (percentage)
  resets_at: string | null;  // ISO 8601
}

export interface UsageData {
  five_hour: UsageLimit;
  seven_day: UsageLimit;
  seven_day_sonnet?: UsageLimit;
  seven_day_opus?: UsageLimit;
  seven_day_oauth_apps?: UsageLimit;
  seven_day_cowork?: UsageLimit;
  extra_usage?: UsageLimit;
}

export interface UsageSnapshot {
  data: UsageData | null;
  error: string | null;
  lastFetch: string | null;   // Pacific timestamp
  nextFetch: string | null;   // Pacific timestamp
}
