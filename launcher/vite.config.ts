import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Which renderer a build contains. `build:renderer:mac` selects `web-gpt`; `build:renderer` does not. */
export const RENDERER_VARIANT_FILE = "renderer-variant.json";

/**
 * Record the renderer this build contains, so the running app can say which one it is.
 *
 * The two entries differ only by an environment variable, and the release workflow uses
 * `package:mac` while `app:package` — the cross-platform CI check — does not. Packaging through the
 * wrong one produced an app that launched, worked, and quietly showed the previous renderer. A
 * build that names its own renderer makes that a reported fact instead of something noticed by
 * looking at the window.
 */
function recordRendererVariant() {
  const variant = process.env.VITE_LAUNCHER_FRONTEND === "web-gpt" ? "web-gpt" : "legacy";
  return {
    name: "codex-web-gpt-renderer-variant",
    generateBundle(this: { emitFile: (file: { type: "asset"; fileName: string; source: string }) => void }) {
      this.emitFile({
        type: "asset",
        fileName: RENDERER_VARIANT_FILE,
        source: `${JSON.stringify({ variant }, null, 2)}\n`,
      });
    },
  };
}

/**
 * The renderer entry this build contains.
 *
 * Choosing between the two with a runtime conditional left both in the module graph, so a Web GPT
 * build emitted the legacy renderer and its assets as well — including 2.1 MB of screen recordings
 * that the shipped app has no way to load. Resolving the choice here means the other entry is never
 * part of the build.
 */
const frontendEntry = process.env.VITE_LAUNCHER_FRONTEND === "web-gpt"
  ? "./src/web-gpt/App.tsx"
  : "./src/App.tsx";

export default defineConfig({
  plugins: [react(), recordRendererVariant()],
  root: ".",
  base: "./",
  resolve: {
    alias: {
      "#launcher-frontend": fileURLToPath(new URL(frontendEntry, import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome138",
    sourcemap: false,
  },
  define: {
    __WEB_GPT_FRONTEND__: JSON.stringify(process.env.VITE_LAUNCHER_FRONTEND === "web-gpt"),
  },
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
    watch: {
      ignored: ["**/build/**", "**/release/**"],
    },
  },
});
