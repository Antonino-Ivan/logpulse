# logpulse

La media dice che il servizio va bene. Il p99 dice che una richiesta su cento impiega tre secondi.

logpulse legge un file di log — NDJSON o formato combined di nginx e Apache — e restituisce ciò che serve davvero per capire come si comporta un servizio: percentili di latenza, tasso di errore, forma del traffico nel tempo, percorsi più richiesti e percorsi più lenti. In un comando, senza aprire una dashboard.

```
$ logpulse examples/app.ndjson
Riepilogo
  richieste       420
  errori          6  (1.43%)
  finestra        14.2 min
  throughput      0.49 richieste/s
  traffico        5.6 MB

Latenza
  p50 85 ms   p90 359 ms   p95 599 ms   p99 2.09 s   max 3.01 s
  media 187 ms su 420 richieste con durata misurata

Traffico nel tempo
  ▃▃▃▃▃▃▃▃▃▄▃▃▃▄▄▃▃▄▃▄▄▄▄▅▅▆██▇▆▅▄▄▄▃▄▃▃▃▃▃▄▃▃▃▃▄▃
   █               █  █   █ █               █       errori
  14:00:00                                14:13:51

Percorsi più lenti (p95)
  percorso              n     p95
  -------------------  --  ------
  /api/report/mensile  16  2.88 s
  /admin/coda          10  656 ms
  /api/preventivi      77  398 ms
```

Zero dipendenze a runtime. TypeScript compilato, in esecuzione su Node 20 o successivo.

## Installazione

```bash
npm install -g logpulse
```

Oppure senza installarlo:

```bash
npx logpulse access.log
```

## Uso

```bash
logpulse access.log                        # formato dedotto dalla prima riga
logpulse app.ndjson --json                 # riepilogo in JSON
cat /var/log/nginx/access.log | logpulse   # da standard input
logpulse *.log --path /api --status 5xx    # solo gli errori delle API
logpulse app.ndjson --since 2026-09-05T14:00:00Z --until 2026-09-05T15:00:00Z
logpulse app.ndjson --top 20 --slowest 10 --buckets 80
```

| Opzione | Effetto |
| --- | --- |
| `--format auto\|ndjson\|combined` | forza il formato invece di dedurlo |
| `--json` | riepilogo completo in JSON |
| `--top <n>` | quanti percorsi mostrare per numero di richieste (default 10) |
| `--slowest <n>` | quanti percorsi mostrare per p95 (default 5, `0` per nascondere) |
| `--buckets <n>` | risoluzione dell'istogramma temporale (default 48) |
| `--path <testo>` | solo i percorsi che contengono il testo |
| `--status <codice\|classe>` | `404` oppure `5xx` |
| `--since` / `--until` | finestra temporale in ISO 8601 |
| `--max-error-rate <%>` | esce con codice 1 se il tasso di errore la supera |
| `--max-p95 <ms>` | esce con codice 1 se il p95 supera la soglia |
| `--quiet` | non segnalare le righe scartate |

## Formati riconosciuti

### NDJSON

Un oggetto JSON per riga. I nomi dei campi non sono standardizzati fra un framework e l'altro, quindi logpulse riconosce gli alias più diffusi invece di pretendere una mappatura:

| Campo | Alias accettati |
| --- | --- |
| istante | `timestamp`, `time`, `ts`, `@timestamp`, `datetime`, `date`, `eventTime` |
| metodo | `method`, `verb`, `http_method`, `httpMethod` |
| percorso | `path`, `url`, `route`, `uri`, `request_uri`, `endpoint` |
| stato | `status`, `status_code`, `statusCode`, `http_status`, `code` |
| durata | `latency_ms`, `duration_ms`, `response_time`, `elapsed_ms`, `took_ms`, `latency`, `duration`, `elapsed`, `took` |
| byte | `bytes`, `size`, `bytes_sent`, `response_size`, `content_length` |
| livello | `level`, `severity`, `lvl` |

Due dettagli che fanno la differenza sui numeri finali:

- un campo di durata il cui nome **non** dichiara i millisecondi (`duration`, `latency`, `took`) viene letto come secondi, che è la convenzione di nginx e di gran parte dei middleware;
- un timestamp numerico sotto `10^11` viene letto come secondi epoch, sopra come millisecondi. La soglia sta fra il 1973 e il 5138: nessuna ambiguità reale.

### Combined

Il formato di nginx e Apache, con o senza `$request_time` in coda:

```
10.0.0.1 - - [05/Sep/2026:14:00:00 +0000] "GET /api/x HTTP/1.1" 200 5120 "-" "Mozilla/5.0" 0.250
```

La data in stile Apache viene interpretata con il suo fuso orario: `Date.parse` da solo non la legge, e ignorare l'offset sposterebbe l'intero istogramma di qualche ora.

## Cosa conta come errore

Uno stato `5xx`, oppure un livello di log `error` o `fatal`. Un `404` non è un errore del servizio: è una richiesta per qualcosa che non esiste, e mescolarlo agli errori nasconde i guasti veri sotto il rumore dei bot.

## I percentili

Interpolazione lineare fra i due campioni adiacenti, lo stesso metodo di Prometheus e NumPy. Contare per indice arrotondato darebbe un p95 leggermente diverso da quello degli strumenti con cui questi numeri verranno confrontati, e un p95 che non combacia con la dashboard non serve a nessuno.

## Uso come soglia in CI

I codici di uscita rendono logpulse un cancello, non solo un visualizzatore:

```yaml
- name: I log di staging devono rispettare gli obiettivi
  run: |
    logpulse staging.ndjson \
      --since "$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)" \
      --max-error-rate 1 \
      --max-p95 800
```

| Codice | Significato |
| --- | --- |
| `0` | analisi completata entro le soglie |
| `1` | una soglia è stata superata |
| `2` | argomenti o file non utilizzabili |

## Uso come libreria

```ts
import { parse } from "logpulse/dist/parse.js";
import { summarize, slowest } from "logpulse/dist/stats.js";

const { entries, skipped } = parse(await readFile("access.log", "utf8"));
const summary = summarize(entries, { top: 20 });

console.log(summary.latency.p99, summary.errorRate, skipped.length);
```

Le righe non interpretabili non vengono ignorate in silenzio: finiscono in `skipped` con numero di riga e motivo. Un parser che scarta senza dirlo mente sui totali, ed è il modo più rapido per fidarsi di un numero sbagliato.

## Come è fatto

| File | Responsabilità |
| --- | --- |
| `src/parse.ts` | riconoscimento del formato, alias dei campi, date CLF, unità di misura |
| `src/stats.ts` | percentili, aggregazioni per percorso, istogramma temporale |
| `src/render.ts` | tabelle allineate, sparkline, formattazione di durate e byte |
| `src/cli.ts` | argomenti, filtri, soglie, codici di uscita |

## Sviluppo

```bash
npm ci
npm run typecheck
npm test
```

69 test su parser, statistiche, resa e riga di comando. Fra questi, un confronto fra lo stesso traffico registrato nei due formati: i totali e il p95 devono coincidere, altrimenti uno dei due parser sta sbagliando le unità.

## Licenza

MIT — vedi [LICENSE](LICENSE).
