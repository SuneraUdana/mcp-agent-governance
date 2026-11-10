import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  preview: { port: 4173 },
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: process.env.API_URL ?? 'http://localhost:3000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => {
            if (process.env.ADMIN_API_TOKEN) request.setHeader('authorization', `Bearer ${process.env.ADMIN_API_TOKEN}`);
          });
        },
      },
    },
  },
});
