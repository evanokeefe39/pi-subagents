import { Type } from "typebox";

const ParallelTaskItem = Type.Object({
  agent: Type.String({ description: "Remote agent name" }),
  task: Type.String({ description: "Task to delegate" }),
});

export const SubagentHttpParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name for delegation or status target" })),
  task: Type.Optional(Type.String({ description: "Task to delegate to the agent" })),
  action: Type.Optional(Type.String({
    enum: ["list", "status"],
    description: "Management action. Omit for delegation mode.",
  })),
  id: Type.Optional(Type.String({
    description: "Run id or prefix for action='status'",
  })),
  tasks: Type.Optional(Type.Array(ParallelTaskItem, {
    description: "PARALLEL mode: delegate to multiple agents concurrently",
  })),
  context: Type.Optional(Type.String({
    description: "Additional context to include with the delegation request",
  })),
});
