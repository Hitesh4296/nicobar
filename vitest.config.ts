import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    test: {
      projects: [
        { test: { name: 'node', include: ['test/node/**/*.test.ts'], environment: 'node' } },
        {
          plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations, DEV_MODE: '1', DEV_ACTOR: 'test@local', RUN_KEY: 'test-run-key-9f3a' } } })],
          test: { name: 'worker', include: ['test/worker/**/*.test.ts'] },
        },
      ],
    },
  };
});
