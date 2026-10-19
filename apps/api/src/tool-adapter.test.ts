import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHttpToolAdapter, ToolTransportError } from './tool-adapter.js';

async function startMcpServer(handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    handler(request, response, JSON.parse(body) as Record<string, unknown>);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test('MCP adapter initializes a session and calls tools/call', async () => {
  const methods: string[] = [];
  const { server, url } = await startMcpServer((_request, response, body) => {
    methods.push(String(body.method));
    response.setHeader('content-type', 'application/json');
    if (body.method === 'initialize') {
      response.setHeader('Mcp-Session-Id', 'session-1');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }));
    } else if (body.method === 'notifications/initialized') {
      response.statusCode = 202;
      response.end();
    } else {
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: 'hello' }], status: 'executed' },
      }));
    }
  });
  const adapter = createHttpToolAdapter(url, 1000);
  const result = await adapter({ toolId: 'demo-tool', action: 'invoke', payload: { message: 'hello' }, correlationId: 'corr-1' });
  assert.deepEqual(result, { toolId: 'demo-tool', output: { content: [{ type: 'text', text: 'hello' }], status: 'executed' } });
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call']);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('MCP adapter surfaces protocol errors and malformed responses', async () => {
  const protocol = await startMcpServer((_request, response, body) => {
    response.setHeader('content-type', 'application/json');
    if (body.method === 'initialize') {
      response.setHeader('Mcp-Session-Id', 'session-2');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }));
    } else if (body.method === 'notifications/initialized') {
      response.statusCode = 202;
      response.end();
    } else {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'invalid arguments' } }));
    }
  });
  const adapter = createHttpToolAdapter(protocol.url, 1000);
  await assert.rejects(adapter({ toolId: 'demo-tool', action: 'invoke', payload: {}, correlationId: 'corr-2' }), (error: unknown) =>
    error instanceof ToolTransportError && error.message === 'MCP error -32602: invalid arguments');
  await new Promise<void>((resolve, reject) => protocol.server.close((error) => error ? reject(error) : resolve()));

  const malformed = await startMcpServer((_request, response, body) => {
    response.setHeader('content-type', 'application/json');
    if (body.method === 'initialize') response.end(JSON.stringify({ unexpected: true }));
    else response.end('{}');
  });
  await assert.rejects(createHttpToolAdapter(malformed.url, 1000)({ toolId: 'demo-tool', action: 'invoke', payload: {}, correlationId: 'corr-3' }),
    (error: unknown) => error instanceof ToolTransportError && error.message.includes('malformed JSON-RPC'));
  await new Promise<void>((resolve, reject) => malformed.server.close((error) => error ? reject(error) : resolve()));
});

test('MCP adapter reports timeouts', async () => {
  const { server, url } = await startMcpServer(() => {});
  await assert.rejects(createHttpToolAdapter(url, 10)({ toolId: 'demo-tool', action: 'invoke', payload: {}, correlationId: 'corr-4' }),
    (error: unknown) => error instanceof ToolTransportError && error.message.includes('timed out'));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
