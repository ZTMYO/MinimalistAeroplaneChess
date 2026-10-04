import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        game: 'game.html',
        admin: 'admin.html',
        spectate: 'spectate.html',
        replay: 'replay.html',
        stats: 'stats.html'
      }
    }
  },
  appType: 'mpa',
  server: {
    ...this?.server,
    fs: {
      allow: [projectRoot]
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    },
    middlewareMode: false,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url;
        if (url === '/') {
          req.url = '/index.html';
        }
        else if (url === '/game') {
          req.url = '/game.html';
        }
        else if (url === '/admin') {
          req.url = '/admin.html';
        }
        else if (url === '/spectate') {
          req.url = '/spectate.html';
        }
        else if (url === '/stats') {
          req.url = '/stats.html';
        }
        else if (url.startsWith('/game?')) {
          req.url = url.replace('/game?', '/game.html?');
        }
        else if (url.startsWith('/admin?')) {
          req.url = url.replace('/admin?', '/admin.html?');
        }
        else if (url.startsWith('/stats?')) {
          req.url = url.replace('/stats?', '/stats.html?');
        }
        else if (url.startsWith('/spectate?')) {
          req.url = url.replace('/spectate?', '/spectate.html?');
        }
        else if (url.startsWith('/spectate')) {
          req.url = '/spectate.html' + url.substring(9);
        }
        
        next();
      });
    }
  }
})