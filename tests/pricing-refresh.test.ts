import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

describe('explicit pricing refresh failures', () => {
  it.each([true, false])('returns failure without replacing or inventing a snapshot (existing=%s)', existing => {
    const root = mkdtempSync(join(tmpdir(), 'anymodel-refresh-fixture-'));
    try {
      mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'src/generated'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      for (const name of ['fetch-pricing.ts', 'pricing-overrides.ts']) copyFileSync(resolve('scripts', name), join(root, 'scripts', name));
      copyFileSync(resolve('prices.json'), join(root, 'prices.json'));
      const snapshot = join(root, 'src/generated/pricing.ts');
      if (existing) writeFileSync(snapshot, 'previous reviewed snapshot\n');
      const deny = join(root, 'deny-network.mjs');
      writeFileSync(deny, `globalThis.fetch=async()=>{throw Error('fixture: network disabled')};`);
      const run = spawnSync(process.execPath, ['--import', deny, '--import', createRequire(import.meta.url).resolve('tsx'), join(root, 'scripts/fetch-pricing.ts')], { encoding: 'utf8' });
      expect(run.status).toBe(1); expect(run.stderr).toContain('Pricing refresh failed; existing snapshot was not replaced.');
      expect(existsSync(snapshot)).toBe(existing);
      if (existing) expect(readFileSync(snapshot, 'utf8')).toBe('previous reviewed snapshot\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
