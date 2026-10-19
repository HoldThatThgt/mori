import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// main 与 kernel 一起构建到 out/main；依赖（含 pi）默认 external，随 node_modules 发布。
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          kernel: resolve(__dirname, 'src/kernel/index.ts'),
        },
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [react()],
  },
});
