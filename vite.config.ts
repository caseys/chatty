import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// The commit being built: a new one opens Settings on its first load (see main.ts)
function appVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

// Writes the build's assets/ file names into dist/sw.js (replacing its empty BUILD_ASSETS list),
// so the worker can precache the current chunks and prune old ones. It also makes sw.js differ
// on every build, which is what makes browsers install the new worker after a deploy.
function swBuildAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'chatty-sw-build-assets',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const swPath = resolve(outDir, 'sw.js');
      const assets = readdirSync(resolve(outDir, 'assets')).sort();
      const sw = readFileSync(swPath, 'utf8');
      const marker = '/*__BUILD_ASSETS__*/ []';
      if (!sw.includes(marker)) throw new Error('sw.js has no BUILD_ASSETS marker');
      writeFileSync(swPath, sw.replace(marker, JSON.stringify(assets)));
    },
  };
}

export default defineConfig({
  // Deployed at https://www.mudberry.com/chatty/
  base: '/chatty/',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        debug: resolve(import.meta.dirname, 'debug.html'),
      },
    },
  },
  plugins: [swBuildAssets()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['cactus-needle', '@litert-lm/core', '@realtimex/piper-tts-web'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});

