#!/usr/bin/env node
// xMonkey entry point.
import { main } from '../src/cli/run.mjs';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    process.stderr.write(`\nfatal: ${err?.message ?? err}\n`);
    if (process.env.XMONKEY_DEBUG) process.stderr.write(String(err?.stack ?? ''));
    process.exitCode = 1;
  });
