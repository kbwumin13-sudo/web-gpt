import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import {
  catalogMatchesExpected,
  expectedWebModelEfforts,
  expectedWebModels,
  publishedWebCatalogEvidence,
} from "../src/readiness";

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
