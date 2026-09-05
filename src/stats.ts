import type { Bucket, Entry, LatencyStats, PathStats, Summary } from "./types.js";

/** Numero di intervalli in cui dividere l'asse dei tempi, se non specificato. */
export const DEFAULT_BUCKETS = 48;

const EMPTY_LATENCY: LatencyStats = { count: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };

/**
 * Percentile con interpolazione lineare fra i due campioni adiacenti.
 *
 * È il metodo che restituisce lo stesso p95 di Prometheus e di NumPy: contare
 * per indice arrotondato darebbe valori diversi dagli strumenti con cui questi
 * numeri verranno confrontati, e un p95 che non combacia non serve a niente.
 */
export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * Math.min(Math.max(fraction, 0), 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function latencyStats(values: number[]): LatencyStats {
  const usable = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (usable.length === 0) return { ...EMPTY_LATENCY };
  const total = usable.reduce((sum, value) => sum + value, 0);
  return {
    count: usable.length,
    mean: total / usable.length,
    p50: percentile(usable, 0.5),
    p90: percentile(usable, 0.9),
    p95: percentile(usable, 0.95),
    p99: percentile(usable, 0.99),
    max: usable[usable.length - 1],
  };
}

export function isError(entry: Entry): boolean {
  return entry.status >= 500 || entry.level === "error" || entry.level === "fatal";
}

function statusClass(status: number): string {
  if (status <= 0) return "n/d";
  return `${Math.floor(status / 100)}xx`;
}

export function buildBuckets(entries: Entry[], count: number): Bucket[] {
  const timed = entries.filter((entry) => Number.isFinite(entry.timestamp));
  if (timed.length === 0 || count < 1) return [];

  const from = Math.min(...timed.map((entry) => entry.timestamp));
  const to = Math.max(...timed.map((entry) => entry.timestamp));
  // Con un solo istante di riferimento la larghezza sarebbe zero: un secondo
  // evita la divisione per zero e produce un unico intervallo, che è corretto.
  const width = Math.max((to - from) / count, 1);

  const buckets: Bucket[] = Array.from({ length: count }, (_, index) => ({
    start: from + index * width,
    count: 0,
    errors: 0,
  }));

  for (const entry of timed) {
    const index = Math.min(Math.floor((entry.timestamp - from) / width), count - 1);
    buckets[index].count += 1;
    if (isError(entry)) buckets[index].errors += 1;
  }
  return buckets;
}

function pathStats(entries: Entry[], top: number): PathStats[] {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = entry.path || "-";
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  const stats: PathStats[] = [];
  for (const [path, group] of groups) {
    const errors = group.filter(isError).length;
    stats.push({
      path,
      count: group.length,
      errors,
      errorRate: errors / group.length,
      p95: latencyStats(group.map((entry) => entry.latencyMs)).p95,
      totalBytes: group.reduce((sum, entry) => sum + (Number.isFinite(entry.bytes) ? entry.bytes : 0), 0),
    });
  }

  stats.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return stats.slice(0, top);
}

export function summarize(entries: Entry[], options: { top?: number; buckets?: number } = {}): Summary {
  const top = options.top ?? 10;
  const bucketCount = options.buckets ?? DEFAULT_BUCKETS;

  if (entries.length === 0) {
    return {
      total: 0, errors: 0, errorRate: 0, from: 0, to: 0, spanMs: 0, requestsPerSecond: 0,
      latency: { ...EMPTY_LATENCY }, statuses: [], classes: [], paths: [], buckets: [], totalBytes: 0,
    };
  }

  const timestamps = entries.map((entry) => entry.timestamp).filter(Number.isFinite);
  const from = timestamps.length ? Math.min(...timestamps) : 0;
  const to = timestamps.length ? Math.max(...timestamps) : 0;
  const spanMs = to - from;

  const errors = entries.filter(isError).length;

  const statusCounts = new Map<number, number>();
  const classCounts = new Map<string, number>();
  for (const entry of entries) {
    statusCounts.set(entry.status, (statusCounts.get(entry.status) ?? 0) + 1);
    const label = statusClass(entry.status);
    classCounts.set(label, (classCounts.get(label) ?? 0) + 1);
  }

  return {
    total: entries.length,
    errors,
    errorRate: errors / entries.length,
    from,
    to,
    spanMs,
    // Su una finestra di durata nulla il rapporto non è definito: meglio zero
    // che un valore infinito che poi finisce in un grafico.
    requestsPerSecond: spanMs > 0 ? entries.length / (spanMs / 1000) : 0,
    latency: latencyStats(entries.map((entry) => entry.latencyMs)),
    statuses: [...statusCounts.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count || a.status - b.status),
    classes: [...classCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    paths: pathStats(entries, top),
    buckets: buildBuckets(entries, bucketCount),
    totalBytes: entries.reduce((sum, entry) => sum + (Number.isFinite(entry.bytes) ? entry.bytes : 0), 0),
  };
}

export function slowest(entries: Entry[], top: number): PathStats[] {
  const stats = pathStats(entries, Number.POSITIVE_INFINITY);
  return stats
    .filter((item) => item.p95 > 0)
    .sort((a, b) => b.p95 - a.p95 || a.path.localeCompare(b.path))
    .slice(0, top);
}
