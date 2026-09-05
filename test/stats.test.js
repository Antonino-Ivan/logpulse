import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildBuckets, isError, latencyStats, percentile, slowest, summarize } from "../dist/stats.js";

function entry(overrides = {}) {
  return {
    timestamp: Date.UTC(2026, 8, 5, 14, 0, 0),
    method: "GET",
    path: "/",
    status: 200,
    latencyMs: 100,
    bytes: 1000,
    level: "info",
    ...overrides,
  };
}

describe("percentile", () => {
  const valori = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("interpola fra i campioni adiacenti", () => {
    assert.equal(percentile(valori, 0.5), 5.5);
    assert.equal(percentile(valori, 0.9), 9.1);
  });

  it("restituisce gli estremi per 0 e 1", () => {
    assert.equal(percentile(valori, 0), 1);
    assert.equal(percentile(valori, 1), 10);
  });

  it("gestisce liste vuote e con un solo elemento", () => {
    assert.equal(percentile([], 0.95), 0);
    assert.equal(percentile([42], 0.95), 42);
  });

  it("limita le frazioni fuori intervallo", () => {
    assert.equal(percentile(valori, -1), 1);
    assert.equal(percentile(valori, 2), 10);
  });
});

describe("latencyStats", () => {
  it("calcola media, percentili e massimo", () => {
    const stats = latencyStats([10, 20, 30, 40, 50]);
    assert.equal(stats.count, 5);
    assert.equal(stats.mean, 30);
    assert.equal(stats.p50, 30);
    assert.equal(stats.max, 50);
  });

  it("scarta i valori non numerici invece di propagarli", () => {
    const stats = latencyStats([10, Number.NaN, 30, Number.POSITIVE_INFINITY]);
    assert.equal(stats.count, 2);
    assert.equal(stats.mean, 20);
  });

  it("restituisce zeri quando non c'è nessuna durata", () => {
    assert.deepEqual(latencyStats([Number.NaN]), { count: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 });
  });
});

describe("isError", () => {
  it("considera errore uno stato 5xx", () => {
    assert.equal(isError(entry({ status: 500 })), true);
    assert.equal(isError(entry({ status: 404 })), false);
  });

  it("considera errore anche un livello di log esplicito", () => {
    assert.equal(isError(entry({ status: 200, level: "error" })), true);
    assert.equal(isError(entry({ status: 200, level: "fatal" })), true);
    assert.equal(isError(entry({ status: 200, level: "warn" })), false);
  });
});

describe("buildBuckets", () => {
  const base = Date.UTC(2026, 8, 5, 14, 0, 0);

  it("distribuisce le voci sugli intervalli", () => {
    const voci = [0, 1000, 2000, 3000].map((offset) => entry({ timestamp: base + offset }));
    const buckets = buildBuckets(voci, 4);
    assert.equal(buckets.length, 4);
    assert.equal(
      buckets.reduce((sum, bucket) => sum + bucket.count, 0),
      4,
    );
  });

  it("mette l'ultima voce nell'ultimo intervallo e non oltre", () => {
    const voci = [0, 10_000].map((offset) => entry({ timestamp: base + offset }));
    const buckets = buildBuckets(voci, 5);
    assert.equal(buckets[4].count, 1);
  });

  it("conta gli errori separatamente", () => {
    const voci = [entry({ timestamp: base }), entry({ timestamp: base + 100, status: 503 })];
    const buckets = buildBuckets(voci, 1);
    assert.equal(buckets[0].count, 2);
    assert.equal(buckets[0].errors, 1);
  });

  it("regge un istante unico senza dividere per zero", () => {
    const buckets = buildBuckets([entry(), entry()], 10);
    assert.equal(buckets.length, 10);
    assert.equal(buckets[0].count, 2);
  });

  it("ignora le voci senza timestamp", () => {
    assert.deepEqual(buildBuckets([entry({ timestamp: Number.NaN })], 4), []);
  });
});

describe("summarize", () => {
  const base = Date.UTC(2026, 8, 5, 14, 0, 0);
  const voci = [
    entry({ timestamp: base, path: "/a", latencyMs: 50 }),
    entry({ timestamp: base + 1000, path: "/a", latencyMs: 150 }),
    entry({ timestamp: base + 2000, path: "/b", latencyMs: 900, status: 500 }),
    entry({ timestamp: base + 3000, path: "/b", latencyMs: 800 }),
    entry({ timestamp: base + 4000, path: "/c", latencyMs: 20, status: 404 }),
  ];

  it("conta richieste ed errori", () => {
    const summary = summarize(voci);
    assert.equal(summary.total, 5);
    assert.equal(summary.errors, 1);
    assert.equal(summary.errorRate, 0.2);
  });

  it("calcola la finestra temporale e il throughput", () => {
    const summary = summarize(voci);
    assert.equal(summary.spanMs, 4000);
    assert.equal(summary.requestsPerSecond, 1.25);
  });

  it("ordina i percorsi per numero di richieste", () => {
    const summary = summarize(voci);
    assert.deepEqual(
      summary.paths.map((item) => item.path),
      ["/a", "/b", "/c"],
    );
    assert.equal(summary.paths[1].errors, 1);
    assert.equal(summary.paths[1].errorRate, 0.5);
  });

  it("rispetta il limite top", () => {
    assert.equal(summarize(voci, { top: 2 }).paths.length, 2);
  });

  it("raggruppa le classi di stato", () => {
    const classi = Object.fromEntries(summarize(voci).classes.map((item) => [item.label, item.count]));
    assert.deepEqual(classi, { "2xx": 3, "4xx": 1, "5xx": 1 });
  });

  it("restituisce un riepilogo vuoto senza voci", () => {
    const summary = summarize([]);
    assert.equal(summary.total, 0);
    assert.equal(summary.requestsPerSecond, 0);
    assert.deepEqual(summary.paths, []);
  });

  it("non produce un throughput infinito su finestra nulla", () => {
    const summary = summarize([entry(), entry()]);
    assert.equal(summary.spanMs, 0);
    assert.equal(summary.requestsPerSecond, 0);
  });
});

describe("slowest", () => {
  it("ordina per p95 decrescente", () => {
    const voci = [
      entry({ path: "/lento", latencyMs: 5000 }),
      entry({ path: "/medio", latencyMs: 500 }),
      entry({ path: "/veloce", latencyMs: 5 }),
    ];
    assert.deepEqual(
      slowest(voci, 2).map((item) => item.path),
      ["/lento", "/medio"],
    );
  });

  it("esclude i percorsi senza durata misurata", () => {
    assert.deepEqual(slowest([entry({ path: "/x", latencyMs: Number.NaN })], 5), []);
  });
});
