import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Release output is aggressively minified before the optional Parallax
  // control-flow obfuscation pass runs. Source maps and legal comments are
  // intentionally omitted from packaged builds.
  build: {
    target: "es2020",
    minify: "esbuild",
    sourcemap: false,
    cssMinify: true,
    reportCompressedSize: false,
  },
  esbuild: {
    drop: ["console", "debugger"],
    legalComments: "none",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
