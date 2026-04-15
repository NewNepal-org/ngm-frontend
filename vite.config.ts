import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'https://ngm-store.jawafdehi.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/r2-testing': {
        target: 'https://pub-4c5659ae2e0249e99311f6c50897f48a.r2.dev',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/r2-testing/, ''),
      },
    },
  },
})