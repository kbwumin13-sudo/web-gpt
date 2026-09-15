const STATES = new Set(["unknown", "pending", "ready", "error"]);

function readinessFromState(state, published = state.readiness?.publishedWebModels || []) {
  const expected = Array.isArray(state.readiness?.expectedWebModels)
    ? state.readiness.expectedWebModels
    : [];
  const core = state.coreSetupComplete;
  const catalog = state.codexCatalogVerified;
  const runtime = state.mcpRuntimeInstalled;
  const connector = state.mcpSetupComplete;
  return {
    route: core === true ? "ready" : core === false ? "error" : "unknown",
    proxy: core === true ? "ready" : core === false ? "error" : "unknown",
    catalog: catalog === true ? "ready" : core === true ? "pending" : core === false ? "error" : "unknown",
    tunnel: runtime === true ? "ready" : core === true ? "pending" : core === false ? "error" : "unknown",
    connector: connector === true ? "ready" : runtime === true ? "pending" : runtime === false ? "error" : "unknown",
    runner: runtime === true && catalog === true ? "ready" : core === true ? "pending" : core === false ? "error" : "unknown",
    restartRequired: state.codexRestartRequired === true,
    expectedWebModels: [...expected].sort(),
    publishedWebModels: Array.isArray(published) ? [...published].sort() : [],
  };
}

function normalizeReadiness(state) {
  const readiness = readinessFromState(state);
  const candidate = state.readiness;
  if (candidate && typeof candidate === "object") {
    for (const key of ["route", "proxy", "catalog", "tunnel", "connector", "runner"]) {
      if (STATES.has(candidate[key])) readiness[key] = candidate[key];
    }
    if (typeof candidate.restartRequired === "boolean") readiness.restartRequired = candidate.restartRequired;
    if (Array.isArray(candidate.expectedWebModels)) readiness.expectedWebModels = [...candidate.expectedWebModels].filter(value => typeof value === "string").sort();
    if (Array.isArray(candidate.publishedWebModels)) readiness.publishedWebModels = [...candidate.publishedWebModels].filter(value => typeof value === "string").sort();
  }
  return readiness;
}

function catalogReady(readiness) {
  return JSON.stringify(readiness.expectedWebModels) === JSON.stringify(readiness.publishedWebModels);
}

module.exports = { catalogReady, normalizeReadiness, readinessFromState };
