#!/usr/bin/env node

import { startServer } from './server.js';

declare const __ANYMODEL_VERSION__: string;

const args = process.argv.slice(2);

if (args[0] === 'serve') {
  const port = getArg(args, '--port', '4141');
  const host = getArg(args, '--host', '127.0.0.1');

  startServer({
    port: parseInt(port, 10),
    host,
  });
} else {
  console.log(`@probeo/anymodel v${__ANYMODEL_VERSION__}`);
  console.log('');
  console.log('Usage:');
  console.log('  anymodel serve [--port 4141] [--host 127.0.0.1]');
  console.log('');
  console.log('SDK usage:');
  console.log('  import { AnyModel } from "@probeo/anymodel";');
  console.log('  const client = new AnyModel();');
  console.log('  const res = await client.chat.completions.create({');
  console.log('    model: "anthropic/claude-sonnet-4-6",');
  console.log('    messages: [{ role: "user", content: "Hello" }]');
  console.log('  });');
}

function getArg(args: string[], flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return defaultValue;
}
