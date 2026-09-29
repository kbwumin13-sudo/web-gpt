import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { proxyBuildError } from "../src/doctor";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import {
  catalogMatchesExpected,
  expectedWebModelEfforts,
  expectedWebModels,
  publishedWebCatalogEvidence,
} from "../src/readiness";

test("doctor compares candidate backend separately from preserved native gateway", () => {
  const config = defaultConfig("browser-only");
  config.releaseVersion = "5.0.7-local.65";
  expect(proxyBuildError(config, {
    version: "5.0.7-local.64",
    build: { version: "5.0.7-local.64", bundleId: "a".repeat(64) },
    backend_build: { version: config.releaseVersion },
  })).toBeUndefined();
  expect(proxyBuildError(config, {
    version: "5.0.7-local.64",
    backend_build: { version: "5.0.7-local.64" },
  })).toContain("Web backend version");
});

test("catalog readiness requires the exact Web rows and fixed effort contract", () => {
  const config = defaultConfig("full");
  config.extraHighAvailable = true;
  config.proAvailable = false;
  const catalog = augmentNativeModelCatalog({
    models: [{
      slug: "gpt-5.6-sol",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "high" }],
      tool_mode: "code_mode_only",
    }],
  }, config);
  const evidence = publishedWebCatalogEvidence(catalog);
  expect(evidence.publishedWebModels).toEqual([...expectedWebModels(config)].sort());
  expect(catalogMatchesExpected({
    expectedWebModels: expectedWebModels(config),
    publishedWebModels: evidence.publishedWebModels,
    expectedWebModelEfforts: expectedWebModelEfforts(config),
    publishedWebModelEfforts: evidence.publishedWebModelEfforts,
  })).toBeTrue();
  expect(catalogMatchesExpected({
    expectedWebModels: expectedWebModels(config),
    publishedWebModels: evidence.publishedWebModels,
    expectedWebModelEfforts: { ...expectedWebModelEfforts(config), "chatgpt-web/high": "medium" },
    publishedWebModelEfforts: evidence.publishedWebModelEfforts,
  })).toBeFalse();
});
