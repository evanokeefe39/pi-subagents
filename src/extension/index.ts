/**
 * Subagent HTTP Extension
 *
 * Delegates tasks to remote agents over HTTP.
 * - Single: { agent, task } — fire-and-forget to one remote agent
 * - Parallel: { tasks: [...] } — concurrent delegation to multiple agents
 * - Management: { action: "list" | "status" } — inspect agents and runs
 *
 * Remote agents must implement: POST /invoke (202), GET /status/:runId, GET /result/:runId
 *
 * Config file: ~/.pi/agent/extensions/subagent-http/config.json
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { SubagentHttpParams } from "./schemas.ts";
import { loadConfig } from "./config.ts";
import type { RemoteRun, RemoteRunState, ResultResponse } from "../transport/types.ts";
import { getAgent, listAgents } from "../transport/config.ts";
import { invoke, getStatus, getResult } from "../transport/http-client.ts";
import { JobTracker } from "../transport/job-tracker.ts";

export { loadConfig } from "./config.ts";

interface HttpDetails {
  mode: "single" | "parallel" | "management";
  runId?: string;
  runs?: Array<{ runId: string; agent: string; state: string }>;
}

export default function registerSubagentHttpExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const defaultTimeoutMs = config.defaults?.timeoutMs ?? 300000;
  const pollIntervalMs = config.defaults?.pollIntervalMs ?? 3000;
  const tracker = new JobTracker(pollIntervalMs);

  // Register completion notifications
  tracker.onEvent((event) => {
    if (event.type === "completed" || event.type === "failed" || event.type === "timeout") {
      const status = event.type === "completed" ? "✓" : "✗";
      const preview = event.result?.output?.slice(0, 200) ?? event.error ?? "(no output)";
      try {
        pi.sendMessage(`${status} Remote subagent ${event.agent} ${event.type}: ${preview}`);
      } catch { /* session may be gone */ }
    }
  });

  const tool: ToolDefinition<typeof SubagentHttpParams, HttpDetails> = {
    name: "subagent",
    label: "Remote Subagent",
    description: `Delegate tasks to remote agents running as HTTP services.

DELEGATION (use exactly one mode):
• SINGLE: { agent: "name", task: "do something" }
• PARALLEL: { tasks: [{agent: "a", task: "..."}, {agent: "b", task: "..."}] }

MANAGEMENT:
• { action: "list" } — show available remote agents and their URLs
• { action: "status" } — show all active runs
• { action: "status", id: "abc" } — check specific run by id or prefix

Remote agents must implement: POST /invoke (returns 202), GET /status/:runId, GET /result/:runId`,
    parameters: SubagentHttpParams,

    async execute(_id, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<HttpDetails>> {
      // ACTION: list
      if (params.action === "list") {
        const agents = listAgents(config);
        if (agents.length === 0) {
          return {
            content: [{ type: "text", text: "No remote agents configured. Add agents to ~/.pi/agent/extensions/subagent-http/config.json" }],
            details: { mode: "management" },
          };
        }
        const lines = agents.map(a => `• ${a.name} — ${a.url}${a.description ? ` (${a.description})` : ""}`);
        return {
          content: [{ type: "text", text: `Remote agents:\n${lines.join("\n")}` }],
          details: { mode: "management" },
        };
      }

      // ACTION: status
      if (params.action === "status") {
        if (params.id) {
          // specific run
          const run = tracker.get(params.id);
          if (!run) {
            return {
              content: [{ type: "text", text: `No run found matching '${params.id}'` }],
              isError: true,
              details: { mode: "management" },
            };
          }
          // poll fresh status
          try {
            const freshStatus = await getStatus(run.url, run.runId);
            run.state = freshStatus.state as RemoteRunState;
            run.lastCheckedAt = Date.now();
            if (freshStatus.state === "completed" || freshStatus.state === "failed") {
              try {
                const result = await getResult(run.url, run.runId);
                run.result = result;
                run.state = result.state as RemoteRunState;
                if (result.error) run.error = result.error;
              } catch { /* result fetch failed, use status */ }
            }
          } catch {
            // connectivity error — show last known state
          }
          const lines = [
            `Run: ${run.runId}`,
            `Agent: ${run.agent} (${run.url})`,
            `State: ${run.state}`,
            `Started: ${new Date(run.startedAt).toISOString()}`,
            run.lastCheckedAt ? `Last checked: ${new Date(run.lastCheckedAt).toISOString()}` : null,
            run.error ? `Error: ${run.error}` : null,
            run.result?.output ? `Output:\n${run.result.output}` : null,
          ].filter(Boolean);
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { mode: "management", runId: run.runId },
          };
        }
        // all runs
        const allRuns = tracker.getAll();
        if (allRuns.length === 0) {
          return {
            content: [{ type: "text", text: "No runs tracked." }],
            details: { mode: "management" },
          };
        }
        const lines = allRuns.map(r => {
          const elapsed = Math.floor((Date.now() - r.startedAt) / 1000);
          return `• [${r.state}] ${r.agent} (${r.runId.slice(0, 8)}) — ${elapsed}s`;
        });
        return {
          content: [{ type: "text", text: `Runs:\n${lines.join("\n")}` }],
          details: { mode: "management", runs: allRuns.map(r => ({ runId: r.runId, agent: r.agent, state: r.state })) },
        };
      }

      // DELEGATION: parallel
      if (params.tasks && params.tasks.length > 0) {
        const results: Array<{ agent: string; runId?: string; error?: string }> = [];
        const runs: RemoteRun[] = [];

        await Promise.allSettled(params.tasks.map(async (t) => {
          const endpoint = getAgent(config, t.agent);
          if (!endpoint) {
            results.push({ agent: t.agent, error: `Unknown agent: ${t.agent}` });
            return;
          }
          try {
            const resp = await invoke(endpoint.url, { task: t.task, context: params.context });
            const run: RemoteRun = {
              runId: resp.runId,
              agent: t.agent,
              url: endpoint.url,
              task: t.task,
              state: "running",
              startedAt: Date.now(),
              timeoutMs: endpoint.timeoutMs ?? defaultTimeoutMs,
              pollIntervalMs,
            };
            tracker.track(run);
            runs.push(run);
            results.push({ agent: t.agent, runId: resp.runId });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ agent: t.agent, error: msg });
          }
        }));

        const lines = results.map(r =>
          r.error ? `✗ ${r.agent}: ${r.error}` : `✓ ${r.agent}: delegated [${r.runId!.slice(0, 8)}]`
        );
        const hasErrors = results.some(r => r.error);
        return {
          content: [{ type: "text", text: `Parallel delegation:\n${lines.join("\n")}\n\nUse subagent({ action: "status" }) to check progress.` }],
          isError: hasErrors && runs.length === 0 ? true : undefined,
          details: {
            mode: "parallel",
            runs: runs.map(r => ({ runId: r.runId, agent: r.agent, state: r.state })),
          },
        };
      }

      // DELEGATION: single
      if (params.agent && params.task) {
        const endpoint = getAgent(config, params.agent);
        if (!endpoint) {
          return {
            content: [{ type: "text", text: `Unknown agent: ${params.agent}. Use subagent({ action: "list" }) to see available agents.` }],
            isError: true,
            details: { mode: "single" },
          };
        }
        try {
          const resp = await invoke(endpoint.url, { task: params.task, context: params.context });
          const run: RemoteRun = {
            runId: resp.runId,
            agent: params.agent,
            url: endpoint.url,
            task: params.task,
            state: "running",
            startedAt: Date.now(),
            timeoutMs: endpoint.timeoutMs ?? defaultTimeoutMs,
            pollIntervalMs,
          };
          tracker.track(run);
          return {
            content: [{ type: "text", text: `Delegated to ${params.agent} [${resp.runId.slice(0, 8)}]\n\nThe task is running asynchronously. Use subagent({ action: "status", id: "${resp.runId.slice(0, 8)}" }) to check progress.` }],
            details: { mode: "single", runId: resp.runId },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Failed to delegate to ${params.agent}: ${msg}` }],
            isError: true,
            details: { mode: "single" },
          };
        }
      }

      // No valid mode
      return {
        content: [{ type: "text", text: "Provide { agent, task } for single delegation, { tasks: [...] } for parallel, or { action: \"list\" }." }],
        isError: true,
        details: { mode: "management" },
      };
    },

    renderCall(args, theme) {
      if (args.action === "list") return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}list`, 0, 0);
      if (args.action === "status") {
        const target = args.id ? ` ${args.id}` : "";
        return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}status${target}`, 0, 0);
      }
      if (args.tasks?.length) {
        return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${args.tasks.length})`, 0, 0);
      }
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "?")}`, 0, 0);
    },

    renderResult(result, _options, _theme) {
      const text = result.content?.map(c => c.type === "text" ? c.text : "").join("") ?? "";
      return new Text(text, 0, 0);
    },
  };

  pi.registerTool(tool);

  pi.on("session_shutdown", () => {
    tracker.stop();
  });
}
