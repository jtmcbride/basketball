import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const proxy = {
  '/api': {
    target: process.env.BASKETBALL_API_URL ?? 'http://127.0.0.1:8007',
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    strictPort: true,
    proxy,
  },
  preview: { proxy },
  test: { include: ['src/**/*.test.ts'] },
});
