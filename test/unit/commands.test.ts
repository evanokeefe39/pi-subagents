import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for registerCommands and registerShortcuts from extension/commands.ts.
 *
 * commands.ts imports invoke() from http-client.ts which uses global fetch,
 * so we mock globalThis.fetch where needed. The pi ExtensionAPI is mocked
 * with simple maps tracking registrations and messages.
 */

// Dynamic import to avoid top-level side effects with peer deps
async function loadCommands() {
  try {
    return await import("../../src/extension/commands.ts");
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cannot find package")) {
      // Peer deps not installed — verify source exists as fallback
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(new URL("../../src/extension/commands.ts", import.meta.url), "utf-8");
      assert.ok(src.includes("registerCommands"), "registerCommands should exist in source");
      assert.ok(src.includes("registerShortcuts"), "registerShortcuts should exist in source");
      return null;
    }
    throw err;
  }
}

interface MockMessage {
  msg: { customType: string; content: string; display: boolean };
  opts: { triggerTurn: boolean };
}

function createMockPi() {
  const commands = new Map<string, { description: string; handler: Function }>();
  const shortcuts = new Map<string, { description: string; handler: Function }>();
  const messages: MockMessage[] = [];
  return {
    registerCommand: (name: string, opts: { description: string; handler: Function }) => {
      commands.set(name, opts);
    },
    registerShortcut: (key: string, opts: { description: string; handler: Function }) => {
      shortcuts.set(key, opts);
    },
    sendMessage: (msg: any, opts: any) => {
      messages.push({ msg, opts });
    },
    commands,
    shortcuts,
    messages,
  };
}

function mockFetchForInvoke(runId: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ runId, status: "accepted" }),
      text: async () => JSON.stringify({ runId, status: "accepted" }),
    };
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

describe("registerCommands", () => {
  it("registers one command per agent", async () => {
    const mod = await loadCommands();
    if (!mod) return; // peer deps unavailable — skip gracefully

    const pi = createMockPi();
    const config = {
      agents: [
        { name: "researcher", url: "http://localhost:8082" },
        { name: "writer", url: "http://localhost:8084" },
      ],
    };
    const waitForResult = async () => ({ state: "completed" as const, durationMs: 100 });
    const formatResult = (agent: string, poll: any) => `${agent}: ${poll.state}`;

    mod.registerCommands(pi as any, config, waitForResult, formatResult);

    assert.equal(pi.commands.size, 2, "should register 2 commands");
    assert.ok(pi.commands.has("researcher"), "researcher command registered");
    assert.ok(pi.commands.has("writer"), "writer command registered");
  });

  it("registers aliases", async () => {
    const mod = await loadCommands();
    if (!mod) return;

    const pi = createMockPi();
    const config = {
      agents: [
        { name: "researcher", url: "http://localhost:8082" },
      ],
      commands: { aliases: { re: "researcher" } },
    };
    const waitForResult = async () => ({ state: "completed" as const, durationMs: 100 });
    const formatResult = (agent: string, poll: any) => `${agent}: done`;

    mod.registerCommands(pi as any, config, waitForResult, formatResult);

    assert.ok(pi.commands.has("re"), "alias 're' registered");
    assert.equal(pi.commands.get("re")!.description, "Alias for /researcher");
  });

  it("does nothing when commands.enabled is false", async () => {
    const mod = await loadCommands();
    if (!mod) return;

    const pi = createMockPi();
    const config = {
      agents: [
        { name: "researcher", url: "http://localhost:8082" },
      ],
      commands: { enabled: false },
    };
    const waitForResult = async () => ({ state: "completed" as const, durationMs: 100 });
    const formatResult = () => "";

    mod.registerCommands(pi as any, config, waitForResult, formatResult);

    assert.equal(pi.commands.size, 0, "no commands registered when disabled");
  });

  it("command handler sends usage message when called with empty args", async () => {
    const mod = await loadCommands();
    if (!mod) return;

    const pi = createMockPi();
    const config = {
      agents: [
        { name: "researcher", url: "http://localhost:8082" },
      ],
    };
    const waitForResult = async () => ({ state: "completed" as const, durationMs: 100 });
    const formatResult = () => "";

    mod.registerCommands(pi as any, config, waitForResult, formatResult);

    const handler = pi.commands.get("researcher")!.handler;
    await handler("");

    assert.equal(pi.messages.length, 1, "one message sent");
    assert.ok(pi.messages[0]!.msg.content.includes("Usage"), "usage message");
    assert.equal(pi.messages[0]!.opts.triggerTurn, false, "usage does not trigger turn");
  });

  it("command handler delegates and sends result", async () => {
    const mod = await loadCommands();
    if (!mod) return;

    const pi = createMockPi();
    const config = {
      agents: [
        { name: "researcher", url: "http://localhost:8082" },
      ],
    };
    const waitForResult = async () => ({
      state: "completed" as const,
      result: { output: "findings" },
      durationMs: 500,
    });
    const formatResult = (agent: string, poll: any) => `${agent}: ${poll.state}`;

    mod.registerCommands(pi as any, config, waitForResult, formatResult);

    const handler = pi.commands.get("researcher")!.handler;

    // Mock fetch for the invoke() call inside the handler
    const m = mockFetchForInvoke("r1");
    try {
      await handler("find stuff about AI");

      // Should send: 1) delegating message, 2) result message
      assert.equal(pi.messages.length, 2, "two messages sent");
      assert.ok(
        pi.messages[0]!.msg.content.includes("Delegating"),
        "first message is delegating notification",
      );
      assert.equal(pi.messages[0]!.opts.triggerTurn, false, "delegating msg does not trigger turn");
      assert.equal(pi.messages[1]!.msg.customType, "subagent-result", "second is result");
      assert.equal(pi.messages[1]!.opts.triggerTurn, true, "result triggers turn");
    } finally {
      m.restore();
    }
  });
});

describe("registerShortcuts", () => {
  it("registers shortcuts from config", async () => {
    const mod = await loadCommands();
    if (!mod) return;

    const pi = createMockPi();
    const config = {
      agents: [
        { name: "researcher", url: "http://localhost:8082" },
        { name: "writer", url: "http://localhost:8084" },
      ],
      shortcuts: { "ctrl+r": "researcher", "ctrl+w": "writer" },
    };

    mod.registerShortcuts(pi as any, config);

    assert.equal(pi.shortcuts.size, 2, "two shortcuts registered");
    assert.ok(pi.shortcuts.has("ctrl+r"), "ctrl+r shortcut registered");
    assert.ok(pi.shortcuts.has("ctrl+w"), "ctrl+w shortcut registered");
    assert.equal(
      pi.shortcuts.get("ctrl+r")!.description,
      "Send to researcher",
      "shortcut description correct",
    );
  });

  it("does nothing without shortcuts in config", async () => {
    const mod = await loadCommands();
    if (!mod) return;

    const pi = createMockPi();
    const config = {
      agents: [
        { name: "researcher", url: "http://localhost:8082" },
      ],
    };

    mod.registerShortcuts(pi as any, config);

    assert.equal(pi.shortcuts.size, 0, "no shortcuts registered");
  });
});
