/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// `npm run build`         -> normal multi-file site in dist/ (relative paths: works from any sub-folder, e.g. GitHub Pages).
// `npm run build:single`  -> ONE self-contained dist-single/index.html you can email or open from disk.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    outDir: mode === 'single' ? 'dist-single' : 'dist',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
  },
}))
