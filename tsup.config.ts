import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/cli.ts'],
    format: ['esm', 'cjs'],
    target: 'node18',
    dts: {
      entry: 'src/index.ts',
    },
  },
])
