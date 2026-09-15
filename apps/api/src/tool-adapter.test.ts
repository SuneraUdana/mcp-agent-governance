import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHttpToolAdapter, ToolTransportError } from './tool-adapter.js';

test('HTTP tool adapter forwards invocation and returns external output', async () => {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ received: JSON.parse(body), value: 42 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const adapter = createHttpToolAdapter(`http://127.0.0.1:${address.port}`, 1000);
  const result = await adapter({ toolId: 'demo-tool', action: 'invoke', payload: { input: 'x' }, correlationId: 'corr-1' });
  assert.deepEqual(result.output, {
    received: { toolId: 'demo-tool', action: 'invoke', payload: { input: 'x' }, correlationId: 'corr-1' },
    value: 42,
  });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('HTTP tool adapter surfaces downstream failures', async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 503;
    response.end('unavailable');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const adapter = createHttpToolAdapter(`http://127.0.0.1:${address.port}`, 1000);
  await assert.rejects(
    adapter({ toolId: 'demo-tool', action: 'invoke', payload: {}, correlationId: 'corr-2' }),
    (error: unknown) => error instanceof ToolTransportError && error.message.includes('HTTP 503'),
  );
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
