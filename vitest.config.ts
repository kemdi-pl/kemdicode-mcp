import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    noExternal: ['zod'],
  },
  test: {
    server: {
      deps: {
        inline: ['zod'],
      },
    },
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.d.ts'],
    },
    testTimeout: 30000,
    hookTimeout: 10000,
    teardownTimeout: 5000,
    // Vitest 4 uses top-level pool options
    isolate: true,
    fileParallelism: false,
    sequence: {
      shuffle: false,
    },
    reporters: ['verbose'],
    // Ensure proper cleanup between tests
    restoreMocks: true,
    clearMocks: true,
  },
});
