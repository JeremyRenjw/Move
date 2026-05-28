import { externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default {
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src-shared')
      }
    },
    build: {
      lib: {
        entry: { index: resolve('electron/main.ts') }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    build: {
      lib: {
        entry: { index: resolve('electron/preload.ts') }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: 'src',
    server: {
      host: '127.0.0.1',
      port: 5173
    },
    resolve: {
      alias: {
        '@shared': resolve('src-shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          float: resolve('src/float/index.html'),
          panel: resolve('src/panel/index.html'),
          settings: resolve('src/settings/index.html')
        }
      }
    }
  }
}
