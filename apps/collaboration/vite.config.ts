import { defineConfig } from "vite";
export default defineConfig({
  build: {
    outDir: "dist",
    // The workbench chunk (pdf.js, CodeMirror, the file tree) loads only when a project opens.
    chunkSizeWarningLimit: 1600,
    rolldownOptions: {
      // Shared workbench components mark themselves "use client" for the desktop's Next.js.
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 8788,
    proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } },
  },
});
