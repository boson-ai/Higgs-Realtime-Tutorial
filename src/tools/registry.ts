import { handlers, type ToolResult } from "./handlers";

/**
 * One entry point for running a tool by name.
 *
 * Both the browser client and the probe come through here, so they cannot
 * drift apart: same handlers, same behaviour for a tool that does not exist.
 *
 * Answering for an unknown tool — rather than throwing — matters more than it
 * looks. The model can recover from an answer. It cannot recover from silence:
 * a thrown error here means no `function_call_output` is ever sent, and the
 * model waits forever on a call_id it never hears back about.
 */
export async function dispatch(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const handler = handlers[name];
  if (!handler) {
    return { summary: `There is no tool called ${name}.`, error: "unknown_tool" };
  }
  return handler(args ?? {});
}
