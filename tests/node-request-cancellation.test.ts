import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";
import {
  APP_FIXTURE_DIR,
  PAGES_FIXTURE_DIR,
  buildAppFixture,
  buildPagesFixture,
  startFixtureServer,
} from "./helpers.js";

// Ported from Next.js: test/e2e/cancel-request/stream-cancel.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/cancel-request/stream-cancel.test.ts
//
// Next.js derives `request.signal` from the Node ServerResponse
// (signalFromNodeResponse): it aborts with `ResponseAborted` when the response
// closes before finishing, and never after a normally completed response.

type Probe = { aborted: boolean; reason: string | null } | null;

async function readProbe(baseUrl: string, probePath: string, id: string): Promise<Probe> {
  const response = await fetch(`${baseUrl}${probePath}?mode=status&id=${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Probe;
}

/** Open a request, wait until the handler is running (or streaming), then drop the socket. */
async function disconnectMidRequest(
  baseUrl: string,
  probePath: string,
  id: string,
  mode: "hang" | "stream",
): Promise<void> {
  const client = http.request(`${baseUrl}${probePath}?mode=${mode}&id=${id}`);
  client.on("error", () => {});
  const firstChunk = new Promise<void>((resolve) => {
    client.on("response", (res) => res.once("data", () => resolve()));
  });
  client.end();
  if (mode === "stream") {
    await firstChunk;
  } else {
    await expect
      .poll(() => readProbe(baseUrl, probePath, id), { timeout: 20_000 })
      .toEqual({ aborted: false, reason: null });
  }
  client.destroy();
}

/** POST a body, read the whole response over a non-keep-alive socket, and wait for it to close. */
async function completeRequest(baseUrl: string, probePath: string, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = http.request(`${baseUrl}${probePath}?mode=complete&id=${id}`, {
      method: "POST",
      headers: { connection: "close", "content-type": "text/plain" },
    });
    client.on("error", reject);
    client.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        if (res.socket?.destroyed) resolve(body);
        else res.socket?.once("close", () => resolve(body));
      });
    });
    client.end("payload");
  });
}

type ProbeTarget = { name: string; path: string; streams: boolean };

type ServerTarget = {
  name: string;
  /** Next.js aborts with `ResponseAborted`; undefined skips the reason check. */
  reason?: string;
  probes: ProbeTarget[];
  start: () => Promise<{ baseUrl: string; close: () => Promise<void> }>;
};

async function startBuiltProdServer(entryPath: string) {
  const outDir = path.dirname(path.dirname(entryPath));
  const { server } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir,
    noCompression: true,
    silent: true,
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startDevServer(fixtureDir: string) {
  const { server, baseUrl }: { server: ViteDevServer; baseUrl: string } =
    await startFixtureServer(fixtureDir);
  return { baseUrl, close: () => server.close() };
}

const APP_ROUTE_PROBE = { name: "route handler", path: "/api/request-signal", streams: true };
const PAGES_EDGE_API_PROBE = {
  name: "edge API route",
  path: "/api/edge-request-signal",
  streams: true,
};
const PAGES_MIDDLEWARE_PROBE = {
  name: "middleware",
  path: "/middleware-request-signal",
  streams: false,
};

const targets: ServerTarget[] = [
  {
    name: "App Router production",
    reason: "ResponseAborted",
    probes: [APP_ROUTE_PROBE],
    start: async () => startBuiltProdServer(await buildAppFixture(APP_FIXTURE_DIR)),
  },
  {
    // Served by @vitejs/plugin-rsc through srvx, which owns this signal.
    name: "App Router dev",
    probes: [APP_ROUTE_PROBE],
    start: () => startDevServer(APP_FIXTURE_DIR),
  },
  {
    name: "Pages Router production",
    reason: "ResponseAborted",
    // The Pages production server buffers edge API bodies before sending them,
    // so there is no mid-stream point at which to disconnect.
    probes: [{ ...PAGES_EDGE_API_PROBE, streams: false }, PAGES_MIDDLEWARE_PROBE],
    start: async () => startBuiltProdServer(await buildPagesFixture(PAGES_FIXTURE_DIR)),
  },
  {
    name: "Pages Router dev",
    reason: "ResponseAborted",
    probes: [PAGES_EDGE_API_PROBE, PAGES_MIDDLEWARE_PROBE],
    start: () => startDevServer(PAGES_FIXTURE_DIR),
  },
];

describe.each(targets)("$name request.signal", ({ reason, probes, start }) => {
  let baseUrl: string;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ baseUrl, close } = await start());
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  const aborted = reason === undefined ? { aborted: true } : { aborted: true, reason };

  describe.each(probes)("$name", ({ path: probePath, streams }) => {
    it("aborts when the client disconnects before the response is sent", async () => {
      const id = randomUUID();
      await disconnectMidRequest(baseUrl, probePath, id, "hang");
      await expect
        .poll(() => readProbe(baseUrl, probePath, id), { timeout: 3_000 })
        .toMatchObject(aborted);
    }, 30_000);

    it.runIf(streams)(
      "aborts when the client disconnects while the response streams",
      async () => {
        const id = randomUUID();
        await disconnectMidRequest(baseUrl, probePath, id, "stream");
        await expect
          .poll(() => readProbe(baseUrl, probePath, id), { timeout: 3_000 })
          .toMatchObject(aborted);
      },
      30_000,
    );

    it("does not abort after a request body is read and the response completes", async () => {
      const id = randomUUID();
      expect(await completeRequest(baseUrl, probePath, id)).toBe("ok");
      // Give a wrongly attached request/socket `close` listener time to fire.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await readProbe(baseUrl, probePath, id)).toEqual({ aborted: false, reason: null });
    }, 30_000);
  });
});
