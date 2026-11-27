import { defineConfig, normalizePath } from 'vite';

const root = normalizePath(import.meta.dirname);
const generated = ['output', 'release', 'dist', '.security-stage-*'];

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1', port: 5209, strictPort: true,
    watch: { ignored: watchedPath => /[\\/](?:output|release|dist|\.security-stage-[^\\/]+)(?:[\\/]|$)/.test(watchedPath) },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', ...generated.map(name => `${root}/${name}/**`)] },
  },
  build: { outDir: 'dist', emptyOutDir: false },
});
