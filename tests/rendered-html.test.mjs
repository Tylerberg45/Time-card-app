import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;
const appleWebAppMeta =
  /<meta(?=[^>]*\bname=["']apple-mobile-web-app-capable["'])(?=[^>]*\bcontent=["']yes["'])[^>]*>/i;
const appleTouchIcon =
  /<link(?=[^>]*\brel=["']apple-touch-icon["'])(?=[^>]*\bhref=["']\/apple-touch-icon\.png["'])[^>]*>/i;
const webAppManifest =
  /<link(?=[^>]*\brel=["']manifest["'])(?=[^>]*\bhref=["']\/manifest\.webmanifest["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, developmentPreviewMeta);
  assert.match(html, appleWebAppMeta);
  assert.match(html, appleTouchIcon);
  assert.match(html, webAppManifest);
});

test("exposes a no-cache build identifier for automatic updates", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("version-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/api/timecard?version=1"),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  const result = await response.json();
  assert.equal(typeof result.buildId, "string");
  assert.ok(result.buildId.length > 0);
});

test("ships one-time release notes for the latest user-facing changes", async () => {
  const source = await readFile(new URL("../app/TimeCardApp.tsx", import.meta.url), "utf8");

  assert.match(source, /hazentime-whats-new:/);
  assert.match(source, /Calendar-style time cards/);
  assert.match(source, /Time-off calendar/);
  assert.match(source, /Pay reports/);
  assert.match(source, /Automatic updates/);
  assert.match(source, /Push notifications/);
  assert.match(source, /Time-off push notifications/);
  assert.match(source, /Enable push notifications/);
  assert.match(source, /item\.audience === data\.user\?\.role/);
});

test("notifies employees when a time-off request is reviewed", async () => {
  const source = await readFile(new URL("../app/api/timecard/route.ts", import.meta.url), "utf8");

  assert.match(source, /Time off approved/);
  assert.match(source, /Time-off request denied/);
  assert.match(source, /employeePushSent/);
});
