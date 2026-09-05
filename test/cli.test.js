import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { EXIT_OK, EXIT_THRESHOLD, EXIT_USAGE, applyFilters, matchesStatus, parseArgs, run } from "../dist/cli.js";
import { formatBytes, formatDuration, sparkline } from "../dist/render.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ndjson = path.join(root, "examples", "app.ndjson");
const combined = path.join(root, "examples", "access.log");

function capture() {
  const lines = [];
  return { lines, write: (value) => lines.push(String(value)), text: () => lines.join("\n") };
}

async function invoke(argv) {
  const out = capture();
  const err = capture();
  const code = await run(argv, out.write, err.write);
  return { code, out: out.text(), err: err.text() };
}

describe("parseArgs", () => {
  it("usa valori predefiniti sensati", () => {
    const options = parseArgs([]);
    assert.equal(options.format, "auto");
    assert.equal(options.top, 10);
    assert.equal(options.json, false);
  });

  it("raccoglie i file posizionali", () => {
    assert.deepEqual(parseArgs(["a.log", "b.log"]).files, ["a.log", "b.log"]);
  });

  it("rifiuta un formato sconosciuto", () => {
    assert.throws(() => parseArgs(["--format", "syslog"]), /formato sconosciuto/);
  });

  it("rifiuta un'opzione senza valore", () => {
    assert.throws(() => parseArgs(["--top"]), /richiede un valore/);
    assert.throws(() => parseArgs(["--top", "--json"]), /richiede un valore/);
  });

  it("rifiuta un valore non numerico", () => {
    assert.throws(() => parseArgs(["--top", "molti"]), /non è un numero/);
  });

  it("rifiuta un istante non ISO", () => {
    assert.throws(() => parseArgs(["--since", "ieri"]), /ISO 8601/);
  });

  it("rifiuta un'opzione sconosciuta", () => {
    assert.throws(() => parseArgs(["--boh"]), /opzione sconosciuta/);
  });

  it("rifiuta valori fuori intervallo", () => {
    assert.throws(() => parseArgs(["--buckets", "0"]), /almeno 1/);
    assert.throws(() => parseArgs(["--top", "0"]), /almeno 1/);
  });
});

describe("matchesStatus", () => {
  it("accetta tutto con filtro vuoto", () => {
    assert.equal(matchesStatus(200, ""), true);
  });

  it("confronta un codice esatto", () => {
    assert.equal(matchesStatus(404, "404"), true);
    assert.equal(matchesStatus(403, "404"), false);
  });

  it("confronta una classe", () => {
    assert.equal(matchesStatus(503, "5xx"), true);
    assert.equal(matchesStatus(200, "5xx"), false);
  });

  it("rifiuta un filtro senza senso", () => {
    assert.throws(() => matchesStatus(200, "errori"), /non è un codice/);
  });
});

describe("applyFilters", () => {
  const base = Date.UTC(2026, 8, 5, 14, 0, 0);
  const voci = [
    { timestamp: base, method: "GET", path: "/api/x", status: 200, latencyMs: 1, bytes: 0, level: "" },
    { timestamp: base + 60_000, method: "GET", path: "/altro", status: 500, latencyMs: 1, bytes: 0, level: "" },
    { timestamp: Number.NaN, method: "GET", path: "/api/y", status: 200, latencyMs: 1, bytes: 0, level: "" },
  ];

  it("filtra per sottostringa del percorso", () => {
    const options = parseArgs(["--path", "/api"]);
    assert.equal(applyFilters(voci, options).length, 2);
  });

  it("filtra per classe di stato", () => {
    assert.equal(applyFilters(voci, parseArgs(["--status", "5xx"])).length, 1);
  });

  it("filtra per intervallo temporale", () => {
    const options = parseArgs(["--since", new Date(base + 30_000).toISOString()]);
    const risultato = applyFilters(voci, options);
    assert.equal(risultato.length, 2);
    assert.ok(risultato.some((item) => Number.isNaN(item.timestamp)));
  });
});

describe("render helper", () => {
  it("formatta le durate cambiando unità", () => {
    assert.equal(formatDuration(5.4), "5.4 ms");
    assert.equal(formatDuration(250), "250 ms");
    assert.equal(formatDuration(1500), "1.50 s");
    assert.equal(formatDuration(90_000), "1.5 min");
    assert.equal(formatDuration(0), "0 ms");
  });

  it("formatta i byte con il multiplo giusto", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2.0 kB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  });

  it("disegna una sparkline proporzionale", () => {
    assert.equal(sparkline([]), "");
    // Una serie tutta a zero resta disegnata al livello più basso: lasciarla
    // vuota la renderebbe indistinguibile dall'assenza di dati.
    assert.equal(sparkline([0, 0]), "▁▁");
    const linea = sparkline([1, 10]);
    assert.equal(linea.length, 2);
    assert.notEqual(linea[0], linea[1]);
  });

  it("non rende invisibile un valore diverso da zero", () => {
    assert.notEqual(sparkline([1, 1000])[0], " ");
  });
});

describe("run", () => {
  it("stampa il riepilogo di un file ndjson", async () => {
    const { code, out } = await invoke([ndjson]);
    assert.equal(code, EXIT_OK);
    assert.match(out, /richieste\s+420/);
    assert.match(out, /Latenza/);
  });

  it("legge il formato combined e ottiene gli stessi totali", async () => {
    const primo = await invoke([ndjson, "--json"]);
    const secondo = await invoke([combined, "--json"]);
    const a = JSON.parse(primo.out);
    const b = JSON.parse(secondo.out);
    assert.equal(a.total, b.total);
    assert.equal(a.errors, b.errors);
    assert.equal(Math.round(a.latency.p95), Math.round(b.latency.p95));
  });

  it("produce JSON valido con i campi attesi", async () => {
    const { out } = await invoke([ndjson, "--json"]);
    const payload = JSON.parse(out);
    assert.equal(payload.total, 420);
    assert.ok(payload.latency.p99 >= payload.latency.p95);
    assert.ok(payload.buckets.length > 0);
    assert.ok(payload.paths.length > 0);
    assert.equal(typeof payload.from, "string");
  });

  it("rispetta il filtro sul percorso", async () => {
    const { out } = await invoke([ndjson, "--json", "--path", "/assets"]);
    const payload = JSON.parse(out);
    assert.ok(payload.total > 0);
    assert.ok(payload.paths.every((item) => item.path.startsWith("/assets")));
  });

  it("esce con 1 quando il tasso di errore supera la soglia", async () => {
    const { code, err } = await invoke([ndjson, "--max-error-rate", "0.1"]);
    assert.equal(code, EXIT_THRESHOLD);
    assert.match(err, /tasso di errore/);
  });

  it("esce con 0 quando il tasso di errore rientra nella soglia", async () => {
    const { code } = await invoke([ndjson, "--max-error-rate", "50"]);
    assert.equal(code, EXIT_OK);
  });

  it("esce con 1 quando il p95 supera la soglia", async () => {
    const { code, err } = await invoke([ndjson, "--max-p95", "10"]);
    assert.equal(code, EXIT_THRESHOLD);
    assert.match(err, /p95/);
  });

  it("segnala un file inesistente come errore di uso", async () => {
    const { code, err } = await invoke([path.join(root, "assente.log")]);
    assert.equal(code, EXIT_USAGE);
    assert.match(err, /lettura fallita/);
  });

  it("segnala un'opzione sconosciuta come errore di uso", async () => {
    const { code } = await invoke(["--sconosciuta"]);
    assert.equal(code, EXIT_USAGE);
  });

  it("stampa l'aiuto e la versione", async () => {
    const aiuto = await invoke(["--help"]);
    assert.equal(aiuto.code, EXIT_OK);
    assert.match(aiuto.out, /Uso:/);
    const versione = await invoke(["--version"]);
    assert.match(versione.out, /^\d+\.\d+\.\d+$/);
  });
});
