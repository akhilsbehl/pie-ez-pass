import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  deps: {
    alwaysBundle: ['zod'],
    onlyBundle: ['zod'],
    dts: {
      neverBundle: ['zod'],
    },
  },
})
