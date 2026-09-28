import { expect, test } from "bun:test";
import { AUTOMATION_CONTROLLED_OFF, automatedChromeLaunchOptions, chromeProxyArguments } from "../src/chrome-launch";

test("Chrome receives a safe proxy endpoint without forwarding credentials", () => {
  expect(chromeProxyArguments({ HTTPS_PROXY: "http://127.0.0.1:7891" })).toEqual([
    "--proxy-server=http://127.0.0.1:7891",
  ]);
  expect(chromeProxyArguments({ HTTPS_PROXY: "http://user:secret@127.0.0.1:7891" })).toEqual([]);
  expect(chromeProxyArguments({ HTTPS_PROXY: "not-a-proxy" })).toEqual([]);
});

test("an automated Chrome does not announce itself as automated", () => {
  // Measured against a Cloudflare managed challenge: with navigator.webdriver true the challenge
  // failed on every run; with this switch it passed on every run.
  const options = automatedChromeLaunchOptions({ chromeExecutablePath: "/chrome" }, { environment: {} });
  expect(options.args).toContain(AUTOMATION_CONTROLLED_OFF);
  expect(options.headless).toBeFalse();
});

test("an automated Chrome never exposes a remote debugging port", () => {
  // The port alone, with no client attached, made the same challenge loop even for a human click.
  const options = automatedChromeLaunchOptions({ chromeExecutablePath: "/chrome" }, { environment: {} });
  expect(options.args?.some(arg => arg.startsWith("--remote-debugging-port"))).toBeFalse();
});

test("an automated Chrome keeps its renderer sandbox and the real keychain", () => {
  const options = automatedChromeLaunchOptions({ chromeExecutablePath: "/chrome" }, { environment: {} });
  expect(options.chromiumSandbox).toBeTrue();
  expect(options.ignoreDefaultArgs).toEqual(["--password-store=basic", "--use-mock-keychain"]);
});

test("an automated Chrome leaves through the same proxy as the rest of this process", () => {
  const options = automatedChromeLaunchOptions(
    { chromeExecutablePath: "/chrome" },
    { headless: true, environment: { HTTPS_PROXY: "http://127.0.0.1:7891" } },
  );
  expect(options.args).toContain("--proxy-server=http://127.0.0.1:7891");
  expect(options.headless).toBeTrue();
});
