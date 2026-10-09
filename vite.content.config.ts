import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  publicDir: false,
  plugins: [vue()],
  // Vue's esm-bundler runtime uses this only for compile-time dev/prod branches.
  // Replace it in the isolated-world IIFE; Chrome content scripts have no Node `process` global.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: `${root}src/content/index.ts`,
      name: 'TelegramMediaContent',
      formats: ['iife'],
      fileName: () => 'assets/content.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
