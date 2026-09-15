export type ToolInvocation = {
  toolId: string;
  action: string;
  payload: Record<string, unknown>;
  correlationId: string;
};

export type ToolResult = {
  toolId: string;
  output: Record<string, unknown>;
};

export type ToolAdapter = (invocation: ToolInvocation) => Promise<ToolResult>;

export const localToolAdapter: ToolAdapter = async (invocation) => ({
  toolId: invocation.toolId,
  output: {
    accepted: true,
    action: invocation.action,
    payload: invocation.payload,
    correlationId: invocation.correlationId,
  },
});

export class ToolTransportError extends Error {}

export function createHttpToolAdapter(
  baseUrl = process.env.MCP_TOOL_URL,
  timeoutMs = Number(process.env.MCP_TOOL_TIMEOUT_MS ?? 5000),
): ToolAdapter {
  if (!baseUrl) throw new Error('MCP_TOOL_URL is required for the external tool adapter');
  return async (invocation) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(invocation),
        signal: controller.signal,
      });
      if (!response.ok) throw new ToolTransportError(`tool transport returned HTTP ${response.status}`);
      const output = await response.json() as Record<string, unknown>;
      return { toolId: invocation.toolId, output };
    } catch (error) {
      if (error instanceof ToolTransportError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ToolTransportError(`tool transport timed out after ${timeoutMs}ms`);
      }
      throw new ToolTransportError('tool transport is unavailable');
    } finally {
      clearTimeout(timeout);
    }
  };
}
