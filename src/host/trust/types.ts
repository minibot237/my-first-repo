/**
 * Trust store types — fit_value tracking for content sources.
 * Spec: .local/doc/content-vocabulary.md (Trust Store Integration)
 */

// --- Constants ---

export const DEFAULT_FIT = 0.5;
export const MAX_FIT = 0.9;
export const MIN_FIT = 0.0;
export const MAX_DELTA = 0.15;

// --- Types ---

export type TrustComponentType = "email_sender" | "email_domain" | "web_domain" | "session";

/** Supervisor-managed source classification */
export type TrustList = "known" | "block";

/** A single source's trust record */
export interface TrustEntry {
  sourceId: string;
  componentType: TrustComponentType;
  fitValue: number;
  /** Supervisor-managed list: "known" (personal contact), "block" (reject), or null (normal) */
  list: TrustList | null;
  createdAt: string;
  updatedAt: string;
  evaluationCount: number;
}

/** An entry in the append-only trust change log */
export interface TrustChange {
  ts: string;
  sourceId: string;
  componentType: TrustComponentType;
  previousFit: number;
  delta: number;
  newFit: number;
  reason: string;
  contentId: string | null;
}

/** Snapshot for dashboard state_sync */
export interface TrustSnapshot {
  entries: TrustEntry[];
  recentChanges: TrustChange[];
}
