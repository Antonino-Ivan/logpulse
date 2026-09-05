import type { Entry, LogFormat, ParseOutcome } from "./types.js";

/**
 * Alias accettati per ciascun campo. I log JSON non hanno uno schema condiviso:
 * ogni framework battezza gli stessi valori a modo suo, e chiedere all'utente di
 * dichiarare la mappatura a ogni esecuzione renderebbe lo strumento inutile.
 */
const FIELDS = {
  timestamp: ["timestamp", "time", "ts", "@timestamp", "datetime", "date", "eventTime"],
  method: ["method", "verb", "http_method", "httpMethod", "req_method"],
  path: ["path", "url", "route", "uri", "request_uri", "requestPath", "endpoint"],
  status: ["status", "status_code", "statusCode", "http_status", "response_status", "code"],
  latency: [
    "latency_ms",
    "latencyMs",
    "duration_ms",
    "durationMs",
    "response_time",
    "responseTime",
    "elapsed_ms",
    "took_ms",
    "latency",
    "duration",
    "elapsed",
    "took",
  ],
  bytes: ["bytes", "size", "bytes_sent", "response_size", "content_length", "length"],
  level: ["level", "severity", "lvl", "loglevel"],
} as const;

/**
 * Common Log Format esteso: indirizzo, identità, utente, data, richiesta, stato,
 * byte, e in coda referer, user agent e — su nginx configurato bene — la durata.
 */
const COMBINED =
  /^(\S+)\s+(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+"([A-Z]+)\s+(\S+)\s*([^"]*)"\s+(\d{3})\s+(\d+|-)(?:\s+"([^"]*)"\s+"([^"]*)")?(?:\s+(\d+(?:\.\d+)?))?\s*$/;

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Converte il formato data di Apache, che nessun Date.parse legge da solo. */
export function parseClfDate(value: string): number {
  const match = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/.exec(value.trim());
  if (!match) return Number.NaN;
  const [, day, month, year, hour, minute, second, offset] = match;
  if (!(month in MONTHS)) return Number.NaN;
  const utc = Date.UTC(+year, MONTHS[month], +day, +hour, +minute, +second);
  if (!offset) return utc;
  const sign = offset.startsWith("-") ? 1 : -1;
  const shift = (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5))) * 60_000;
  return utc + sign * shift;
}

function pick(record: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name];
  }
  // Un secondo passaggio senza distinzione fra maiuscole copre i logger che
  // normalizzano le chiavi in modo diverso fra sviluppo e produzione.
  const lowered = new Map(Object.keys(record).map((key) => [key.toLowerCase(), key]));
  for (const name of names) {
    const key = lowered.get(name.toLowerCase());
    if (key !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function toTimestamp(value: unknown): number {
  if (typeof value === "number") {
    // Un valore sotto i 10^11 è quasi certamente in secondi: 10^11 ms cade nel
    // 5138, 10^11 s nel 1973. La soglia separa le due unità senza ambiguità.
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value !== "string") return Number.NaN;
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  return parseClfDate(value);
}

function toLatency(value: unknown, key: string | undefined): number {
  const raw = toNumber(value);
  if (Number.isNaN(raw)) return Number.NaN;
  // I campi che non dichiarano l'unità nel nome contengono spesso secondi:
  // è la convenzione di nginx ($request_time) e di parecchi middleware.
  const isSeconds = key !== undefined && !/ms|milli/i.test(key) && /^(latency|duration|elapsed|took)$/i.test(key);
  return isSeconds ? raw * 1000 : raw;
}

function latencyKey(record: Record<string, unknown>): string | undefined {
  for (const name of FIELDS.latency) {
    if (record[name] !== undefined && record[name] !== null) return name;
  }
  return undefined;
}

export function parseNdjsonLine(line: string): Entry | string {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return "JSON non valido";
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return "la riga non è un oggetto JSON";
  }
  const object = record as Record<string, unknown>;
  const status = toNumber(pick(object, FIELDS.status));
  return {
    timestamp: toTimestamp(pick(object, FIELDS.timestamp)),
    method: String(pick(object, FIELDS.method) ?? "-").toUpperCase(),
    path: String(pick(object, FIELDS.path) ?? "-"),
    status: Number.isNaN(status) ? 0 : Math.trunc(status),
    latencyMs: toLatency(pick(object, FIELDS.latency), latencyKey(object)),
    bytes: toNumber(pick(object, FIELDS.bytes)) || 0,
    level: String(pick(object, FIELDS.level) ?? "").toLowerCase(),
  };
}

export function parseCombinedLine(line: string): Entry | string {
  const match = COMBINED.exec(line);
  if (!match) return "non corrisponde al formato combined";
  const [, , , , date, method, path, , status, bytes, , , duration] = match;
  const seconds = duration === undefined ? Number.NaN : Number(duration);
  return {
    timestamp: parseClfDate(date),
    method,
    path,
    status: Number(status),
    // nginx scrive $request_time in secondi con tre decimali.
    latencyMs: Number.isNaN(seconds) ? Number.NaN : seconds * 1000,
    bytes: bytes === "-" ? 0 : Number(bytes),
    level: "",
  };
}

export function detectFormat(lines: string[]): LogFormat {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    return trimmed.startsWith("{") ? "ndjson" : "combined";
  }
  return "ndjson";
}

export function parse(text: string, format: LogFormat = "auto"): ParseOutcome {
  const lines = text.split(/\r?\n/);
  const resolved = format === "auto" ? detectFormat(lines) : format;
  const parser = resolved === "ndjson" ? parseNdjsonLine : parseCombinedLine;

  const entries: Entry[] = [];
  const skipped: { line: number; reason: string }[] = [];

  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    const outcome = parser(line);
    if (typeof outcome === "string") {
      skipped.push({ line: index + 1, reason: outcome });
      return;
    }
    entries.push(outcome);
  });

  return { entries, skipped, format: resolved };
}
