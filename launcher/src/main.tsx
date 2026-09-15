import React from "react";
import ReactDOM from "react-dom/client";

async function mount() {
  const webGpt = import.meta.env.VITE_LAUNCHER_FRONTEND === "web-gpt";
  const module = webGpt ? await import("./web-gpt/App") : await import("./App");
  if (!webGpt) {
    await import("./tokens.css");
    await import("./styles.css");
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <module.App />
    </React.StrictMode>,
  );
}

void mount();
