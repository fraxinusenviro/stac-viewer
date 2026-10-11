import { defineConfig } from 'vite';

// `base: './'` keeps every URL relative, so the build works at
// fraxinusenviro.github.io/stac-viewer/ and from `vite preview` alike.
export default defineConfig({
  base: './',
  // MapLibre alone is ~800 kB; the warning says nothing about this app.
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  // The point-cloud worker is an ES module (laz-perf loads its wasm by URL).
  worker: { format: 'es' },
});
