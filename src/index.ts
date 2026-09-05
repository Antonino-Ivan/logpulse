#!/usr/bin/env node
import { run } from "./cli.js";

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`logpulse: errore inatteso: ${(error as Error).message}`);
    process.exitCode = 2;
  },
);
