
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/citystreetgame/',
  server: {
    proxy: {
      '/api': 'http://localhost:8000'
    }
  }
})
