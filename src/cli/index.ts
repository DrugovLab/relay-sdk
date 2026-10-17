#!/usr/bin/env node
import { runCli } from './run';

const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  write: (text) => process.stdout.write(`${text}\n`),
  error: (text) => process.stderr.write(`${text}\n`),
});
process.exitCode = code;
