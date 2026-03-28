import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function matchesAny(id: string, needles: string[]): boolean {
  return needles.some((needle) => id.includes(needle))
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // Guard: VITE_API_URL must be set for production builds.
  // Without it, the frontend makes API calls to wrong paths and silently breaks.
  if (mode === 'production' && !env.VITE_API_URL) {
    throw new Error(
      '\n\n❌ VITE_API_URL is not set!\n' +
      'Create frontend/.env with: VITE_API_URL=/api\n' +
      'Without this, the production build will be broken.\n'
    );
  }

  // Vite blocks unknown Host headers in dev to prevent DNS rebinding attacks.
  // Keep this scoped to localhost + this tailnet by default (not "all").
  const allowedHosts = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    // To allow Tailscale dev access, set VITE_ALLOWED_HOSTS=.your-tailnet.ts.net
  ])

  if (env.VITE_ALLOWED_HOSTS) {
    for (const host of env.VITE_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)) {
      allowedHosts.add(host)
    }
  }

  return {
    plugins: [react()],
    server: {
      port: 5173,
      host: '0.0.0.0',
      allowedHosts: Array.from(allowedHosts),
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:4001',
          changeOrigin: true,
        },
        '/assets': {
          target: 'http://127.0.0.1:4001',
          changeOrigin: true,
        },
        '/guacamole': {
          target: 'http://127.0.0.1:8080',
          changeOrigin: true,
          ws: true,
        }
      }
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined

            if (matchesAny(id, ['@monaco-editor', 'monaco-editor'])) return 'monaco'
            if (matchesAny(id, ['xterm', 'xterm-addon-'])) return 'terminal-vendor'
            if (matchesAny(id, ['framer-motion'])) return 'motion-vendor'
            if (matchesAny(id, ['lucide-react'])) return 'icons-vendor'
            if (matchesAny(id, ['axios'])) return 'http-vendor'
            if (matchesAny(id, ['socket.io-client', 'engine.io-client', 'engine.io-parser', 'socket.io-parser', 'component-emitter'])) return 'socket-vendor'
            if (matchesAny(id, ['react-router', '@remix-run/router'])) return 'router-vendor'
            if (matchesAny(id, ['/node_modules/react/', '/node_modules/react-dom/', '/node_modules/scheduler/'])) return 'react-vendor'
            if (matchesAny(id, ['recharts', 'd3-', 'internmap', 'react-smooth', 'fast-equals'])) return 'charts-vendor'
            if (matchesAny(id, ['react-markdown', 'remark-', 'rehype-', 'unified', 'micromark', 'mdast-', 'hast-', 'property-information', 'vfile', 'unist-', 'parse5', 'entities', 'lowlight', 'highlight.js', 'devlop', 'bail', 'space-separated-tokens', 'comma-separated-tokens', 'html-void-elements', 'web-namespaces', 'zwitch', 'trough'])) return 'markdown-vendor'
            if (matchesAny(id, ['dompurify', 'marked', 'highlight.js'])) return 'content-vendor'
            if (matchesAny(id, ['react-dropzone', 'file-selector', 'attr-accept', 'qrcode.react'])) return 'input-vendor'
            if (matchesAny(id, ['xlsx'])) return 'xlsx-vendor'
            if (matchesAny(id, ['react-pdf', 'pdfjs-dist'])) return 'pdf-vendor'

            return undefined
          },
        },
      },
    }
  }
})
