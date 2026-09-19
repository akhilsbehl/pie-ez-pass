import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  deps: {
    alwaysBundle: ['zod', 'pie-jev'],
    onlyBundle: ['zod', 'pie-jev'],
    dts: {
      neverBundle: ['zod', 'pie-jev'],
    },
  },
})
