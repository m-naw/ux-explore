import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          include: ['**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/.worktrees/**', 'test/browser/**'],
          env: {
            ANTHROPIC_API_KEY: 'test-key-for-unit-tests',
          },
          pool: 'forks',
          maxWorkers: 5,
          // Vitest 4 refuses two projects with different maxWorkers and the same
          // groupOrder ("Provide unique 'sequence.groupOrder' for them").
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: 'browser',
          globals: true,
          environment: 'node',
          include: ['test/browser/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/.worktrees/**'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
