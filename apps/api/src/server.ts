import { buildApp } from './app.js';
import { createAgentRepository } from './agent-repository.js';
import { createHttpToolAdapter, localToolAdapter } from './tool-adapter.js';
const port = Number(process.env.API_PORT ?? 3000);
const selected = createAgentRepository();
const invokeTool = process.env.MCP_TOOL_URL ? createHttpToolAdapter() : localToolAdapter;
const app = buildApp(selected.repository, undefined, selected.credentials, selected.audit, invokeTool);
app.addHook('onClose', async () => selected.close?.());
app.listen({ port, host: '0.0.0.0' }).catch((error) => { app.log.error(error); process.exit(1); });
