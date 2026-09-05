/** Una riga di log ridotta a ciò che serve per misurare: tempo, esito, durata. */
export interface Entry {
  /** Millisecondi epoch. NaN quando la riga non porta un timestamp leggibile. */
  timestamp: number;
  method: string;
  path: string;
  status: number;
  /** Durata della richiesta in millisecondi, NaN se il log non la riporta. */
  latencyMs: number;
  bytes: number;
  level: string;
}

export interface ParseOutcome {
  entries: Entry[];
  /** Righe scartate, con numero e motivo: un parser silenzioso mente sui totali. */
  skipped: { line: number; reason: string }[];
  /** Formato effettivamente riconosciuto, utile quando è stato dedotto. */
  format: LogFormat;
}

export type LogFormat = "ndjson" | "combined" | "auto";

export interface Bucket {
  start: number;
  count: number;
  errors: number;
}

export interface LatencyStats {
  count: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

export interface PathStats {
  path: string;
  count: number;
  errors: number;
  errorRate: number;
  p95: number;
  totalBytes: number;
}

export interface Summary {
  total: number;
  errors: number;
  errorRate: number;
  from: number;
  to: number;
  spanMs: number;
  requestsPerSecond: number;
  latency: LatencyStats;
  statuses: { status: number; count: number }[];
  classes: { label: string; count: number }[];
  paths: PathStats[];
  buckets: Bucket[];
  totalBytes: number;
}
