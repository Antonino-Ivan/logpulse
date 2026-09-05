import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectFormat, parse, parseClfDate, parseCombinedLine, parseNdjsonLine } from "../dist/parse.js";

describe("parseNdjsonLine", () => {
  it("legge i campi con i nomi canonici", () => {
    const entry = parseNdjsonLine(
      JSON.stringify({
        timestamp: "2026-09-05T14:00:00.000Z",
        method: "post",
        path: "/api/x",
        status: 201,
        duration_ms: 42,
        bytes: 1024,
        level: "INFO",
      }),
    );
    assert.equal(entry.timestamp, Date.parse("2026-09-05T14:00:00.000Z"));
    assert.equal(entry.method, "POST");
    assert.equal(entry.path, "/api/x");
    assert.equal(entry.status, 201);
    assert.equal(entry.latencyMs, 42);
    assert.equal(entry.bytes, 1024);
    assert.equal(entry.level, "info");
  });

  it("riconosce gli alias dei campi", () => {
    const entry = parseNdjsonLine(
      JSON.stringify({ "@timestamp": "2026-09-05T14:00:00Z", url: "/y", status_code: 404, responseTime: 7 }),
    );
    assert.equal(entry.path, "/y");
    assert.equal(entry.status, 404);
    assert.equal(entry.latencyMs, 7);
  });

  it("interpreta come secondi i campi di durata senza unità nel nome", () => {
    assert.equal(parseNdjsonLine(JSON.stringify({ duration: 1.5 })).latencyMs, 1500);
    assert.equal(parseNdjsonLine(JSON.stringify({ duration_ms: 1.5 })).latencyMs, 1.5);
  });

  it("distingue timestamp in secondi da timestamp in millisecondi", () => {
    assert.equal(parseNdjsonLine(JSON.stringify({ ts: 1_757_080_800 })).timestamp, 1_757_080_800_000);
    assert.equal(parseNdjsonLine(JSON.stringify({ ts: 1_757_080_800_000 })).timestamp, 1_757_080_800_000);
  });

  it("accetta valori numerici scritti come stringa", () => {
    const entry = parseNdjsonLine(JSON.stringify({ status: "503", duration_ms: "12.5" }));
    assert.equal(entry.status, 503);
    assert.equal(entry.latencyMs, 12.5);
  });

  it("segnala le righe non interpretabili invece di inventare valori", () => {
    assert.equal(typeof parseNdjsonLine("non json"), "string");
    assert.equal(typeof parseNdjsonLine("[1, 2]"), "string");
  });

  it("sopravvive ai campi mancanti", () => {
    const entry = parseNdjsonLine(JSON.stringify({ path: "/solo-percorso" }));
    assert.equal(entry.status, 0);
    assert.ok(Number.isNaN(entry.latencyMs));
    assert.equal(entry.bytes, 0);
  });
});

describe("parseClfDate", () => {
  it("legge il formato di Apache con fuso orario", () => {
    assert.equal(parseClfDate("05/Sep/2026:14:00:00 +0000"), Date.UTC(2026, 8, 5, 14, 0, 0));
    assert.equal(parseClfDate("05/Sep/2026:14:00:00 +0200"), Date.UTC(2026, 8, 5, 12, 0, 0));
    assert.equal(parseClfDate("05/Sep/2026:14:00:00 -0500"), Date.UTC(2026, 8, 5, 19, 0, 0));
  });

  it("restituisce NaN su un formato diverso", () => {
    assert.ok(Number.isNaN(parseClfDate("2026-09-05")));
    assert.ok(Number.isNaN(parseClfDate("05/Zzz/2026:14:00:00 +0000")));
  });
});

describe("parseCombinedLine", () => {
  const line =
    '10.0.0.1 - utente [05/Sep/2026:14:00:00 +0000] "GET /api/x HTTP/1.1" 200 5120 "-" "Mozilla/5.0" 0.250';

  it("estrae i campi principali", () => {
    const entry = parseCombinedLine(line);
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/api/x");
    assert.equal(entry.status, 200);
    assert.equal(entry.bytes, 5120);
    assert.equal(entry.latencyMs, 250);
  });

  it("accetta la riga senza durata finale", () => {
    const senzaDurata =
      '10.0.0.1 - - [05/Sep/2026:14:00:00 +0000] "GET / HTTP/1.1" 200 100 "-" "curl/8.0"';
    const entry = parseCombinedLine(senzaDurata);
    assert.equal(entry.status, 200);
    assert.ok(Number.isNaN(entry.latencyMs));
  });

  it("accetta la forma common senza referer e user agent", () => {
    const entry = parseCombinedLine('10.0.0.1 - - [05/Sep/2026:14:00:00 +0000] "GET / HTTP/1.1" 304 -');
    assert.equal(entry.status, 304);
    assert.equal(entry.bytes, 0);
  });

  it("rifiuta una riga che non rispetta il formato", () => {
    assert.equal(typeof parseCombinedLine("questa non e una riga di accesso"), "string");
  });
});

describe("parse", () => {
  it("deduce ndjson dalla prima riga utile", () => {
    assert.equal(detectFormat(["", "  ", '{"a":1}']), "ndjson");
    assert.equal(detectFormat(["10.0.0.1 - - [x]"]), "combined");
  });

  it("raccoglie le righe scartate con il numero di riga", () => {
    const outcome = parse('{"path":"/a"}\nrotta\n{"path":"/b"}\n', "ndjson");
    assert.equal(outcome.entries.length, 2);
    assert.deepEqual(
      outcome.skipped.map((item) => item.line),
      [2],
    );
  });

  it("ignora le righe vuote senza contarle come scartate", () => {
    const outcome = parse('{"path":"/a"}\n\n\n{"path":"/b"}\n', "ndjson");
    assert.equal(outcome.entries.length, 2);
    assert.equal(outcome.skipped.length, 0);
  });

  it("riporta il formato effettivamente usato", () => {
    assert.equal(parse('{"path":"/a"}\n').format, "ndjson");
  });
});
