import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'desktop-lyric': resolve('src/renderer/desktop-lyric.html')
        }
      }
    },
    server: {
      // 5173 落入 Windows Hyper-V 动态保留端口范围（5041-5440），固定用 5501
      port: Number(process.env.LG_DEV_PORT) || 5501,
      strictPort: true
    }
  }
})
