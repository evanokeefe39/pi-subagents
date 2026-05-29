export interface AgentEndpoint {
  name: string;
  url: string;
  description?: string;
  model?: string;
  timeoutMs?: number;
}

export interface HttpConfig {
  agents: AgentEndpoint[];
  defaults?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
}

export interface InvokeRequest {
  task: string;
  context?: string;
  runId?: string;
}

export interface InvokeResponse {
  runId: string;
  status: "accepted";
}

export interface StatusResponse {
  runId: string;
  state: "running" | "completed" | "failed";
  progress?: {
    toolCount: number;
    turnCount: number;
    currentTool?: string;
  };
  partialOutput?: string;
}

export interface ResultResponse {
  runId: string;
  state: "completed" | "failed";
  output: string;
  error?: string;
  usage?: {
    input: number;
    output: number;
    cost: number;
    turns: number;
  };
  durationMs: number;
}

export type RemoteRunState = "pending" | "running" | "completed" | "failed" | "timeout";

export interface RemoteRun {
  runId: string;
  agent: string;
  url: string;
  task: string;
  state: RemoteRunState;
  startedAt: number;
  timeoutMs: number;
  pollIntervalMs: number;
  lastCheckedAt?: number;
  result?: ResultResponse;
  error?: string;
}
