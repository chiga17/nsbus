import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/** Long random path. Anything shorter is too easy to guess, so the admin page is omitted. */
function adminPath(env: Record<string, string>): string | null {
  const value = (env.ADMIN_PATH ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!value) return null
  if (!/^[A-Za-z0-9_-]{16,}$/.test(value)) {
    console.warn('ADMIN_PATH must be at least 16 letters, numbers, "_" or "-". Admin page will not be published.')
    return null
  }
  return value
}

function hideAdmin(secret: string): Plugin {
  const page = `/${secret}`
  return {
    name: 'hide-admin',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        if (url === '/admin.html') {
          res.statusCode = 404
          res.end('not found')
          return
        }
        if (url === page || url === `${page}/`) req.url = '/admin.html'
        next()
      })
    },
    closeBundle() {
      const from = path.resolve('dist/admin.html')
      if (!fs.existsSync(from)) return
      const dir = path.resolve('dist', secret)
      fs.mkdirSync(dir, { recursive: true })
      fs.renameSync(from, path.join(dir, 'index.html'))
    },
  }
}

export default defineConfig(({ mode }) => {
  const secret = adminPath(loadEnv(mode, process.cwd(), ''))
  return {
    plugins: secret ? [hideAdmin(secret)] : [],
    server: {
      proxy: {
        '/buses': { target: 'http://127.0.0.1:8082', changeOrigin: true },
      },
    },
    build: secret
      ? {
          rollupOptions: {
            input: { main: path.resolve('index.html'), admin: path.resolve('admin.html') },
            output: { entryFileNames: 'assets/[hash].js' },
          },
        }
      : undefined,
  }
})
