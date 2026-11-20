import { defineConfig } from 'tsup';
import { version } from './package.json';

export default defineConfig({
  define: { __ANYMODEL_VERSION__: JSON.stringify(version) },
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm', 'cjs'],
  // Bundling avoids CJS/ESM default-export interop differences for this dependency.
  noExternal: ['p-queue'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});
