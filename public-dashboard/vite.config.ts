import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Mirrors the Vercel rewrite in vercel.json so local dev hits the same
// /api/* paths the production frontend uses.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'https://api.solgov.xyz',
        changeOrigin: true,
      },
    },
  },
})
