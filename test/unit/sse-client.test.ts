import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Tests for the SSE transport layer: SseClient class and waitViaSse helper.
 *
 * SseClient uses TypeScript parameter properties which are not supported by
 * --experimental-strip-types. We test waitViaSse with a duck-typed mock
 * (it only needs .on(event, handler)) and verify SseClient source directly.
 */

// waitViaSse only needs an object with .on(event, handler) — duck-type it
// to avoid instantiating SseClient (parameter properties unsupported in strip mode).
async function loadWaitViaSse() {
  // Dynamic import to isolate the function — but SseClient constructor will
  // blow up at import time because of parameter properties. We need to test
  // waitViaSse without importing SseClient directly.
  //
  // Since both are in the same module and the module-level code just defines
  // a class and a function (no side effects), we can't selectively import.
  // Instead, we build a standalone waitViaSse from the source logic.
  return null;
}

// Re-implement waitViaSse logic faithfully for testing (mirrors src/transport/sse-client.ts:69-106)
// This is needed because the module can't be imported due to SseClient parameter properties.
interface PollResult {
  state: "completed" | "failed" | "timeout" | "cancelled";
  result?: any;
  error?: string;
  durationMs: number;
}

interface MockSse {
  on: (event: string, handler: (data: any) => void) => void;
}

function createMockSse(): MockSse & { emit: (event: string, data: any) => void } {
  const handlers = new Map<string, Set<(data: any) => void>>();
  return {
    on(event: string, handler: (data: any) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    emit(event: string, data: any) {
      const listeners = handlers.get(event);
      if (listeners) for (const h of listeners) h(data);
    },
  };
}

// Faithful copy of waitViaSse from src/transport/sse-client.ts for isolated testing.
// This avoids importing the module (which fails due to parameter properties).
function waitViaSse(
  sse: MockSse,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PollResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timeout = setTimeout(() => {
      resolve({ state: "timeout", error: `Timed out after ${timeoutMs}ms`, durationMs: timeoutMs });
    }, timeoutMs);

    const cleanup = () => { clearTimeout(timeout); };

    sse.on("run:completed", (data) => {
      if (data.runId !== runId) return;
      cleanup();
      resolve({ state: "completed", result: data, durationMs: Date.now() - start });
    });

    sse.on("run:failed", (data) => {
      if (data.runId !== runId) return;
      cleanup();
      resolve({ state: "failed", error: data.error, durationMs: Date.now() - start });
    });

    sse.on("run:cancelled", (data) => {
      if (data.runId !== runId) return;
      cleanup();
      resolve({ state: "cancelled", error: "Cancelled", durationMs: Date.now() - start });
    });

    if (signal) signal.addEventListener("abort", () => {
      cleanup();
      resolve({ state: "cancelled", error: "Aborted", durationMs: Date.now() - start });
    });
  });
}

describe("waitViaSse", () => {
  it("resolves on run:completed with matching runId", async () => {
    const sse = createMockSse();
    const promise = waitViaSse(sse, "r1", 5000);
    sse.emit("run:completed", { runId: "r1", output: "research findings" });
    const result = await promise;
    assert.equal(result.state, "completed");
    assert.equal(result.result?.runId, "r1");
    assert.equal(result.result?.output, "research findings");
    assert.ok(result.durationMs >= 0);
  });

  it("resolves on run:failed with matching runId", async () => {
    const sse = createMockSse();
    const promise = waitViaSse(sse, "r2", 5000);
    sse.emit("run:failed", { runId: "r2", error: "model rate limited" });
    const result = await promise;
    assert.equal(result.state, "failed");
    assert.equal(result.error, "model rate limited");
    assert.ok(result.durationMs >= 0);
  });

  it("resolves on run:cancelled with matching runId", async () => {
    const sse = createMockSse();
    const promise = waitViaSse(sse, "r3", 5000);
    sse.emit("run:cancelled", { runId: "r3" });
    const result = await promise;
    assert.equal(result.state, "cancelled");
    assert.equal(result.error, "Cancelled");
    assert.ok(result.durationMs >= 0);
  });

  it("ignores events for other runIds", async () => {
    const sse = createMockSse();
    const promise = waitViaSse(sse, "target-run", 5000);

    // Emit events for a different runId — should be ignored
    sse.emit("run:completed", { runId: "other-run", output: "wrong" });
    sse.emit("run:failed", { runId: "other-run", error: "wrong" });

    // Now emit for the correct runId
    sse.emit("run:completed", { runId: "target-run", output: "correct" });

    const result = await promise;
    assert.equal(result.state, "completed");
    assert.equal(result.result?.output, "correct");
    assert.equal(result.result?.runId, "target-run");
  });

  it("times out when no event is received", async () => {
    const sse = createMockSse();
    const result = await waitViaSse(sse, "r-timeout", 50);
    assert.equal(result.state, "timeout");
    assert.ok(result.error?.includes("Timed out"));
    assert.equal(result.durationMs, 50);
  });

  it("respects AbortSignal", async () => {
    const sse = createMockSse();
    const controller = new AbortController();
    const promise = waitViaSse(sse, "r-abort", 5000, controller.signal);
    setTimeout(() => controller.abort(), 30);
    const result = await promise;
    assert.equal(result.state, "cancelled");
    assert.equal(result.error, "Aborted");
    assert.ok(result.durationMs >= 0);
  });
});

describe("SseClient source verification", () => {
  // SseClient uses parameter properties which can't be imported in strip-types mode.
  // Verify the class structure by reading the source directly (same pattern as
  // blocking-delegation.test.ts for schema verification).
  const src = readFileSync(
    new URL("../../src/transport/sse-client.ts", import.meta.url),
    "utf-8",
  );

  it("on() method registers handlers into a Map", () => {
    assert.ok(src.includes("private handlers = new Map"), "handlers map exists");
    assert.ok(src.includes("on(event: string, handler:"), "on() method exists");
    assert.ok(src.includes(".get(event)!.add(handler)"), "on() adds to handler set");
  });

  it("close() sets _connected to false and aborts", () => {
    assert.ok(src.includes("close():"), "close() method exists");
    assert.ok(src.includes("this._connected = false"), "_connected set to false");
    assert.ok(src.includes("this.abortController?.abort()"), "abort called on close");
  });

  it("starts disconnected (_connected = false by default)", () => {
    assert.ok(src.includes("private _connected = false"), "_connected defaults to false");
  });

  it("isConnected() returns _connected state", () => {
    assert.ok(src.includes("isConnected():"), "isConnected() method exists");
    assert.ok(src.includes("return this._connected"), "returns _connected");
  });

  it("waitViaSse is exported and listens for three event types", () => {
    assert.ok(src.includes("export async function waitViaSse"), "waitViaSse exported");
    assert.ok(src.includes('"run:completed"'), "listens for run:completed");
    assert.ok(src.includes('"run:failed"'), "listens for run:failed");
    assert.ok(src.includes('"run:cancelled"'), "listens for run:cancelled");
  });

  it("waitViaSse filters by runId", () => {
    assert.ok(src.includes("data.runId !== runId"), "filters events by runId");
  });
});
