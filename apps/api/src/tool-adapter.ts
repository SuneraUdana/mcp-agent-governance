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

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const MCP_PROTOCOL_VERSION = '2025-03-26';

export function createHttpToolAdapter(
  baseUrl = process.env.MCP_TOOL_URL,
  timeoutMs = Number(process.env.MCP_TOOL_TIMEOUT_MS ?? 5000),
): ToolAdapter {
  if (!baseUrl) throw new Error('MCP_TOOL_URL is required for the external tool adapter');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('MCP_TOOL_TIMEOUT_MS must be a positive number');
  }

  let nextRequestId = 1;
  let sessionId: string | undefined;
  let initialized: Promise<void> | undefined;

  const request = async (body: Record<string, unknown>, allowSessionRetry = true): Promise<JsonRpcResponse> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      };
      if (sessionId) headers['mcp-session-id'] = sessionId;
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (allowSessionRetry && sessionId && (response.status === 400 || response.status === 404)) {
          sessionId = undefined;
          initialized = undefined;
          await ensureInitialized();
          return request(body, false);
        }
        throw new ToolTransportError(`MCP transport returned HTTP ${response.status}`);
      }
      const responseSessionId = response.headers.get('mcp-session-id');
      if (responseSessionId) sessionId = responseSessionId;
      if (body.method === 'notifications/initialized' && response.status === 202) {
        return { jsonrpc: '2.0' };
      }
      const responseBody = await parseMcpResponse(response);
      if (!isJsonRpcResponse(responseBody)) {
        throw new ToolTransportError('MCP transport returned a malformed JSON-RPC response');
      }
      if (responseBody.error) {
        throw new ToolTransportError(`MCP error ${responseBody.error.code}: ${responseBody.error.message}`);
      }
      return responseBody;
    } catch (error) {
      if (error instanceof ToolTransportError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ToolTransportError(`MCP transport timed out after ${timeoutMs}ms`);
      }
      throw new ToolTransportError('MCP transport is unavailable');
    } finally {
      clearTimeout(timeout);
    }
  };

  const ensureInitialized = async (): Promise<void> => {
    if (sessionId) return;
    initialized ??= (async () => {
      const response = await request({
        jsonrpc: '2.0',
        id: nextRequestId++,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'mcp-agent-governance', version: '0.1.0' },
        },
      }, false);
      if (!response.result || typeof response.result !== 'object') {
        throw new ToolTransportError('MCP initialize response is missing its result');
      }
      const negotiatedVersion = (response.result as { protocolVersion?: unknown }).protocolVersion;
      if (typeof negotiatedVersion !== 'string' || negotiatedVersion.length === 0) {
        throw new ToolTransportError('MCP initialize response is missing protocolVersion');
      }
      if (!sessionId) throw new ToolTransportError('MCP initialize response is missing mcp-session-id');
      await request({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }, false);
    })().catch((error: unknown) => {
      initialized = undefined;
      throw error;
    });
    await initialized;
  };

  return async (invocation) => {
    await ensureInitialized();
    const response = await request({
      jsonrpc: '2.0',
      id: nextRequestId++,
      method: 'tools/call',
      params: {
        name: invocation.toolId,
        arguments: {
          action: invocation.action,
          ...invocation.payload,
          correlationId: invocation.correlationId,
        },
      },
    });
    if (!response.result || typeof response.result !== 'object') {
      throw new ToolTransportError('MCP tools/call response is missing its result');
    }
    const result = response.result as Record<string, unknown>;
    if (result.isError === true) {
      throw new ToolTransportError(extractToolError(result));
    }
    return { toolId: invocation.toolId, output: result };
  };
}

async function parseMcpResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    const data = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean).at(-1);
    if (!data) throw new ToolTransportError('MCP stream contained no data event');
    try {
      return JSON.parse(data);
    } catch {
      throw new ToolTransportError('MCP stream contained invalid JSON');
    }
  }
  try {
    return await response.json();
  } catch {
    throw new ToolTransportError('MCP transport returned invalid JSON');
  }
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<JsonRpcResponse>;
  return response.jsonrpc === '2.0' && (response.id !== undefined || response.error !== undefined);
}

function extractToolError(result: Record<string, unknown>): string {
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text') as Record<string, unknown> | undefined;
    if (typeof text?.text === 'string' && text.text.length > 0) return text.text;
  }
  return 'MCP tool returned an error';
}
