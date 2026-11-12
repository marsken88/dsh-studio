import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Builds the whole Studio panel into one IIFE file (dist/client.js) so the
// deployment story stays "copy one file and restart".
export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    target: 'es2020',
    lib: { entry: 'src/main.jsx', name: 'DshStudio', formats: ['iife'], fileName: () => 'client.js' },
    rollupOptions: { output: { inlineDynamicImports: true, extend: true } },
  },
})
