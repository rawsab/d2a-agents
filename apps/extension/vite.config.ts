import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest })],
  define: { __D2A_PORT__: JSON.stringify(process.env.D2A_PORT ?? "") },
  build: {
    outDir: process.env.D2A_OUT_DIR ?? "dist",
    // The editor is an extension page opened in a tab, not listed in the manifest.
    rollupOptions: { input: { editor: "src/editor/index.html" } },
  },
  server: { port: 5174, strictPort: true, hmr: { port: 5174 } },
});
