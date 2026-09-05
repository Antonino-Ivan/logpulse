import { readFile } from "node:fs/promises";

import { parse } from "./parse.js";
import { DEFAULT_BUCKETS, slowest, summarize } from "./stats.js";
import { renderJson, renderText } from "./render.js";
import type { Entry, LogFormat } from "./types.js";

export const VERSION = "1.0.0";

export const EXIT_OK = 0;
export const EXIT_THRESHOLD = 1;
export const EXIT_USAGE = 2;

export interface Options {
  files: string[];
  format: LogFormat;
  json: boolean;
  top: number;
  buckets: number;
  slowest: number;
  pathFilter: string;
  statusFilter: string;
  since: number;
  until: number;
  maxErrorRate: number;
  maxP95: number;
  quiet: boolean;
  color?: boolean;
}

const USAGE = `logpulse ${VERSION} — percentili, tasso di errore e forma del traffico da un file di log.

Uso:
  logpulse [file...] [opzioni]
  cat access.log | logpulse

Opzioni:
  --format <auto|ndjson|combined>  formato del log (default: auto, dedotto dalla prima riga)
  --json                           riepilogo in JSON invece della tabella
  --top <n>                        percorsi più richiesti da mostrare (default: 10)
  --slowest <n>                    percorsi più lenti per p95 (default: 5, 0 per nasconderli)
  --buckets <n>                    intervalli dell'istogramma temporale (default: ${DEFAULT_BUCKETS})
  --path <testo>                   considera solo i percorsi che contengono il testo
  --status <codice|classe>         filtra per stato: 404 oppure 5xx
  --since <istante>                scarta le righe precedenti (ISO 8601)
  --until <istante>                scarta le righe successive (ISO 8601)
  --max-error-rate <percentuale>   esce con codice 1 se il tasso di errore la supera
  --max-p95 <ms>                   esce con codice 1 se il p95 supera la soglia
  --quiet                          non segnalare le righe scartate
  --version                        stampa la versione
  --help                           stampa questo messaggio

Codici di uscita:
  0  analisi completata entro le soglie
  1  una soglia è stata superata
  2  argomenti o file non utilizzabili`;

export class UsageError extends Error {}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`l'opzione ${flag} richiede un valore`);
  }
  return value;
}

function requireNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`${flag}: ${raw} non è un numero`);
  return value;
}

function requireInstant(raw: string, flag: string): number {
  const value = Date.parse(raw);
  if (Number.isNaN(value)) throw new UsageError(`${flag}: ${raw} non è un istante ISO 8601`);
  return value;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    files: [],
    format: "auto",
    json: false,
    top: 10,
    buckets: DEFAULT_BUCKETS,
    slowest: 5,
    pathFilter: "",
    statusFilter: "",
    since: Number.NEGATIVE_INFINITY,
    until: Number.POSITIVE_INFINITY,
    maxErrorRate: Number.POSITIVE_INFINITY,
    maxP95: Number.POSITIVE_INFINITY,
    quiet: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--format": {
        const value = requireValue(argv, index, "--format");
        if (value !== "auto" && value !== "ndjson" && value !== "combined") {
          throw new UsageError(`formato sconosciuto: ${value}`);
        }
        options.format = value;
        index += 1;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--top":
        options.top = requireNumber(requireValue(argv, index, "--top"), "--top");
        index += 1;
        break;
      case "--slowest":
        options.slowest = requireNumber(requireValue(argv, index, "--slowest"), "--slowest");
        index += 1;
        break;
      case "--buckets":
        options.buckets = requireNumber(requireValue(argv, index, "--buckets"), "--buckets");
        index += 1;
        break;
      case "--path":
        options.pathFilter = requireValue(argv, index, "--path");
        index += 1;
        break;
      case "--status":
        options.statusFilter = requireValue(argv, index, "--status");
        index += 1;
        break;
      case "--since":
        options.since = requireInstant(requireValue(argv, index, "--since"), "--since");
        index += 1;
        break;
      case "--until":
        options.until = requireInstant(requireValue(argv, index, "--until"), "--until");
        index += 1;
        break;
      case "--max-error-rate":
        options.maxErrorRate = requireNumber(requireValue(argv, index, "--max-error-rate"), "--max-error-rate");
        index += 1;
        break;
      case "--max-p95":
        options.maxP95 = requireNumber(requireValue(argv, index, "--max-p95"), "--max-p95");
        index += 1;
        break;
      default:
        if (argument.startsWith("--")) throw new UsageError(`opzione sconosciuta: ${argument}`);
        options.files.push(argument);
    }
  }

  if (options.buckets < 1) throw new UsageError("--buckets deve essere almeno 1");
  if (options.top < 1) throw new UsageError("--top deve essere almeno 1");
  return options;
}

export function matchesStatus(status: number, filter: string): boolean {
  if (filter === "") return true;
  if (/^\d{3}$/.test(filter)) return status === Number(filter);
  const asClass = /^([1-5])xx$/i.exec(filter);
  if (asClass) return Math.floor(status / 100) === Number(asClass[1]);
  throw new UsageError(`--status: ${filter} non è un codice né una classe come 5xx`);
}

export function applyFilters(entries: Entry[], options: Options): Entry[] {
  return entries.filter((entry) => {
    if (options.pathFilter && !entry.path.includes(options.pathFilter)) return false;
    if (!matchesStatus(entry.status, options.statusFilter)) return false;
    // Una riga senza timestamp non può essere esclusa da un filtro temporale
    // senza mentire: viene tenuta, e il conteggio resta onesto.
    if (Number.isFinite(entry.timestamp)) {
      if (entry.timestamp < options.since || entry.timestamp > options.until) return false;
    }
    return true;
  });
}

async function readInput(files: string[]): Promise<string> {
  if (files.length > 0) {
    const parts = await Promise.all(files.map((file) => readFile(file, "utf8")));
    return parts.join("\n");
  }
  if (process.stdin.isTTY) {
    throw new UsageError("nessun file indicato e nessun dato su standard input");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function run(argv: string[], out = console.log, err = console.error): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    out(USAGE);
    return EXIT_OK;
  }
  if (argv.includes("--version")) {
    out(VERSION);
    return EXIT_OK;
  }

  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(error instanceof UsageError ? error.message : String(error));
    return EXIT_USAGE;
  }

  let text: string;
  try {
    text = await readInput(options.files);
  } catch (error) {
    err(error instanceof UsageError ? error.message : `lettura fallita: ${(error as Error).message}`);
    return EXIT_USAGE;
  }

  const parsed = parse(text, options.format);
  let entries: Entry[];
  try {
    entries = applyFilters(parsed.entries, options);
  } catch (error) {
    err(error instanceof UsageError ? error.message : String(error));
    return EXIT_USAGE;
  }

  const summary = summarize(entries, { top: options.top, buckets: options.buckets });
  const slowestPaths = options.slowest > 0 ? slowest(entries, options.slowest) : [];

  if (options.json) {
    out(renderJson(summary, { skipped: parsed.skipped.length, slowest: slowestPaths }));
  } else {
    out(renderText(summary, {
      skipped: options.quiet ? 0 : parsed.skipped.length,
      slowest: slowestPaths,
      color: options.color,
    }));
  }

  const breaches: string[] = [];
  if (summary.errorRate * 100 > options.maxErrorRate) {
    breaches.push(`tasso di errore ${(summary.errorRate * 100).toFixed(2)}% oltre ${options.maxErrorRate}%`);
  }
  if (summary.latency.p95 > options.maxP95) {
    breaches.push(`p95 ${summary.latency.p95.toFixed(0)} ms oltre ${options.maxP95} ms`);
  }
  for (const breach of breaches) err(breach);

  return breaches.length > 0 ? EXIT_THRESHOLD : EXIT_OK;
}
