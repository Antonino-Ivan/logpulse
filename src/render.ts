import type { Bucket, PathStats, Summary } from "./types.js";

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function useColor(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream.isTTY);
}

const CODES: Record<string, string> = {
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
};

function paint(text: string, style: keyof typeof CODES, enabled: boolean): string {
  return enabled ? `${CODES[style]}${text}\u001b[0m` : text;
}

/** Istogramma su una riga sola: dà la forma del traffico senza aprire un grafico. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max === 0) return BLOCKS[0].repeat(values.length);
  return values
    .map((value) => {
      if (value === 0) return " ";
      // Un valore diverso da zero non deve mai apparire come vuoto: si parte
      // dal primo blocco visibile e si distribuisce il resto sulla scala.
      const level = Math.max(1, Math.ceil((value / max) * BLOCKS.length));
      return BLOCKS[Math.min(level, BLOCKS.length) - 1];
    })
    .join("");
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

function table(headers: string[], rows: string[][], aligns: ("l" | "r")[]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => (aligns[index] === "r" ? cell.padStart(widths[index]) : cell.padEnd(widths[index])))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}

function timeAxis(buckets: Bucket[]): string {
  if (buckets.length === 0) return "";
  const first = new Date(buckets[0].start).toISOString().slice(11, 19);
  const last = new Date(buckets[buckets.length - 1].start).toISOString().slice(11, 19);
  const gap = Math.max(buckets.length - first.length - last.length, 1);
  return `${first}${" ".repeat(gap)}${last}`;
}

export function renderText(
  summary: Summary,
  options: { skipped: number; slowest: PathStats[]; color?: boolean } = { skipped: 0, slowest: [] },
): string {
  const color = options.color ?? useColor();
  if (summary.total === 0) return "nessuna riga analizzabile";

  const lines: string[] = [];
  const rate = summary.errorRate;
  const rateStyle = rate >= 0.05 ? "red" : rate > 0 ? "yellow" : "green";

  lines.push(paint("Riepilogo", "bold", color));
  lines.push(`  richieste       ${summary.total}`);
  lines.push(`  errori          ${summary.errors}  (${paint(percent(rate), rateStyle, color)})`);
  lines.push(`  finestra        ${formatDuration(summary.spanMs)}`);
  lines.push(`  throughput      ${summary.requestsPerSecond.toFixed(2)} richieste/s`);
  lines.push(`  traffico        ${formatBytes(summary.totalBytes)}`);
  if (options.skipped > 0) {
    lines.push(`  righe scartate  ${paint(String(options.skipped), "yellow", color)}`);
  }

  if (summary.latency.count > 0) {
    lines.push("");
    lines.push(paint("Latenza", "bold", color));
    const l = summary.latency;
    lines.push(
      `  p50 ${formatDuration(l.p50)}   p90 ${formatDuration(l.p90)}   ` +
        `p95 ${formatDuration(l.p95)}   p99 ${formatDuration(l.p99)}   max ${formatDuration(l.max)}`,
    );
    lines.push(paint(`  media ${formatDuration(l.mean)} su ${l.count} richieste con durata misurata`, "dim", color));
  }

  if (summary.buckets.length > 0) {
    lines.push("");
    lines.push(paint("Traffico nel tempo", "bold", color));
    lines.push(`  ${sparkline(summary.buckets.map((bucket) => bucket.count))}`);
    if (summary.errors > 0) {
      lines.push(`  ${paint(sparkline(summary.buckets.map((bucket) => bucket.errors)), "red", color)}  errori`);
    }
    lines.push(paint(`  ${timeAxis(summary.buckets)}`, "dim", color));
  }

  if (summary.classes.length > 0) {
    lines.push("");
    lines.push(paint("Classi di stato", "bold", color));
    const rows = summary.classes.map((item) => [
      item.label,
      String(item.count),
      percent(item.count / summary.total),
    ]);
    lines.push(...table(["classe", "conteggio", "quota"], rows, ["l", "r", "r"]).map((row) => `  ${row}`));
  }

  if (summary.paths.length > 0) {
    lines.push("");
    lines.push(paint("Percorsi più richiesti", "bold", color));
    const rows = summary.paths.map((item) => [
      item.path.length > 48 ? `${item.path.slice(0, 47)}…` : item.path,
      String(item.count),
      String(item.errors),
      percent(item.errorRate),
      formatDuration(item.p95),
    ]);
    lines.push(...table(["percorso", "n", "errori", "quota", "p95"], rows, ["l", "r", "r", "r", "r"]).map((r) => `  ${r}`));
  }

  if (options.slowest.length > 0) {
    lines.push("");
    lines.push(paint("Percorsi più lenti (p95)", "bold", color));
    const rows = options.slowest.map((item) => [
      item.path.length > 48 ? `${item.path.slice(0, 47)}…` : item.path,
      String(item.count),
      formatDuration(item.p95),
    ]);
    lines.push(...table(["percorso", "n", "p95"], rows, ["l", "r", "r"]).map((row) => `  ${row}`));
  }

  return lines.join("\n");
}

export function renderJson(summary: Summary, options: { skipped: number; slowest: PathStats[] }): string {
  return JSON.stringify(
    {
      total: summary.total,
      errors: summary.errors,
      errorRate: summary.errorRate,
      from: summary.from ? new Date(summary.from).toISOString() : null,
      to: summary.to ? new Date(summary.to).toISOString() : null,
      spanMs: summary.spanMs,
      requestsPerSecond: summary.requestsPerSecond,
      totalBytes: summary.totalBytes,
      skippedLines: options.skipped,
      latency: summary.latency,
      classes: summary.classes,
      statuses: summary.statuses,
      paths: summary.paths,
      slowest: options.slowest,
      buckets: summary.buckets.map((bucket) => ({
        start: new Date(bucket.start).toISOString(),
        count: bucket.count,
        errors: bucket.errors,
      })),
    },
    null,
    2,
  );
}
