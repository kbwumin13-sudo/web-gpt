import { createHash } from "node:crypto";
import type { AppConfig } from "./config";
import { availableChatGptWebModelRoutes, CHATGPT_WEB_MODEL_PREFIX } from "./chatgpt-web-models";

export type ReadinessState = "unknown" | "pending" | "ready" | "error";

export interface RuntimeReadiness {
  route: ReadinessState;
  proxy: ReadinessState;
  catalog: ReadinessState;
  tunnel: ReadinessState;
  connector: ReadinessState;
  runner: ReadinessState;
  restartRequired: boolean;
  expectedWebModels: string[];
  publishedWebModels: string[];
}

export interface ModelCatalogEvidence {
  publishedWebModels: string[];
  publishedWebModelEfforts: Record<string, string>;
  contractHash: string | null;
}

export function expectedWebModelRoutes(config: Pick<AppConfig, "solAvailable" | "extraHighAvailable" | "proAvailable" | "browserInteractionMode" | "experimentalBiggerContext" | "zeroRiskProEnabled">): ReturnType<typeof availableChatGptWebModelRoutes> {
  return availableChatGptWebModelRoutes(config);
}

export function expectedWebModels(config: Parameters<typeof expectedWebModelRoutes>[0]): string[] {
  return [...expectedWebModelRoutes(config)].map(route => route.slug);
}

export function expectedWebModelEfforts(config: Parameters<typeof expectedWebModelRoutes>[0]): Record<string, string> {
  return Object.fromEntries(expectedWebModelRoutes(config).map(route => [route.slug, route.codexEffort]));
}

export function publishedWebCatalogEvidence(catalog: unknown): ModelCatalogEvidence {
  const models: unknown[] = catalog && typeof catalog === "object" && !Array.isArray(catalog)
    && Array.isArray((catalog as Record<string, unknown>).models)
    ? (catalog as Record<string, unknown>).models as unknown[]
    : [];
  const publishedWebModels: string[] = [];
  const publishedWebModelEfforts: Record<string, string> = {};
  for (const candidate of models) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const model = candidate as Record<string, unknown>;
    if (typeof model.slug !== "string" || !model.slug.startsWith(CHATGPT_WEB_MODEL_PREFIX)) continue;
    publishedWebModels.push(model.slug);
    const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
    const effort = levels[0] && typeof levels[0] === "object" && !Array.isArray(levels[0])
      ? (levels[0] as Record<string, unknown>).effort
      : undefined;
    if (typeof effort === "string") publishedWebModelEfforts[model.slug] = effort;
  }
  publishedWebModels.sort();
  const stableEfforts = Object.fromEntries(
    Object.entries(publishedWebModelEfforts).sort(([left], [right]) => left.localeCompare(right)),
  );
  const contract = JSON.stringify({ models: publishedWebModels, efforts: stableEfforts });
  return {
    publishedWebModels,
    publishedWebModelEfforts: stableEfforts,
    contractHash: publishedWebModels.length > 0 ? createHash("sha256").update(contract).digest("hex") : null,
  };
}

export function evaluateRuntimeReadiness(input: {
  route: ReadinessState;
  proxy: ReadinessState;
  catalog: ReadinessState;
  tunnel: ReadinessState;
  connector: ReadinessState;
  runner: ReadinessState;
  restartRequired: boolean;
  expectedWebModels: string[];
  publishedWebModels: string[];
}): RuntimeReadiness {
  return {
    ...input,
    expectedWebModels: [...input.expectedWebModels].sort(),
    publishedWebModels: [...input.publishedWebModels].sort(),
  };
}

export function catalogMatchesExpected(readiness: Pick<RuntimeReadiness, "expectedWebModels" | "publishedWebModels"> & {
  expectedWebModelEfforts?: Record<string, string>;
  publishedWebModelEfforts?: Record<string, string>;
}): boolean {
  if (JSON.stringify([...readiness.expectedWebModels].sort()) !== JSON.stringify([...readiness.publishedWebModels].sort())) return false;
  if (readiness.expectedWebModelEfforts && readiness.publishedWebModelEfforts) {
    const stable = (value: Record<string, string>) => Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
    );
    return JSON.stringify(stable(readiness.expectedWebModelEfforts)) === JSON.stringify(stable(readiness.publishedWebModelEfforts));
  }
  return true;
}
