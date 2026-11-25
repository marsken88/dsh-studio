import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// Builds the whole Studio panel into one IIFE file (dist/client.js) so the
// deployment story stays "copy one file and restart".
export default defineConfig({
  plugins: [react()],
  // BoardUI 的源码用 @/ 作路径根，加个别名就能原样 copy 进来
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    /* 浏览器端注册名 = 包名（编译期常量）。写成短名 dsh-studio 会让宿主按包名取不到工厂，
       模块永远不实例化 → 侧栏没有入口（0.9.0/0.9.1 的症状）。
       做成字面量而不是 import package.json：产物里就一处字符串，镜像 workflow 替换得动，也不把整份 manifest 打进 bundle。 */
    __STUDIO_PKG_NAME__: JSON.stringify(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    target: 'es2020',
    lib: { entry: 'src/main.jsx', name: 'DshStudio', formats: ['iife'], fileName: () => 'client.js' },
    rollupOptions: { output: { inlineDynamicImports: true, extend: true } },
  },
})
