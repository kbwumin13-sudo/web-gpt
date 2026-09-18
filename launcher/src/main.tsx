import React from "react";
import ReactDOM from "react-dom/client";

/**
 * The renderer this build contains, chosen while bundling rather than while running.
 *
 * A runtime conditional between two dynamic imports put both entries in the module graph, so a Web
 * GPT build still emitted the legacy renderer and every asset it referenced — 2.1 MB of screen
 * recordings among them, shipped inside an app that can never load them. `#launcher-frontend`
 * resolves to one entry or the other in `vite.config.ts`, which leaves the other out of the build
 * entirely: 440 modules became 31.
 */
import { App } from "#launcher-frontend";

async function mount() {
  if (!__WEB_GPT_FRONTEND__) {
    await import("./tokens.css");
    await import("./styles.css");
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void mount();
