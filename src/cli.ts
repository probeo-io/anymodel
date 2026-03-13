#!/usr/bin/env node

import { startServer } from './server.js';

const args = process.argv.slice(2);

if (args[0] === 'serve') {
  const port = getArg(args, '--port', '4141');
  const host = getArg(args, '--host', '0.0.0.0');

  startServer({
    port: parseInt(port, 10),
    host,
  });
} else {
  console.log('@probeo/anymodel v0.1.0');
  console.log('');
  console.log('Usage:');
  console.log('  anymodel serve [--port 4141] [--host 0.0.0.0]');
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
