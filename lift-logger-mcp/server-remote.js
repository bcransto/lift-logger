/**
 * IRON MCP server — Streamable HTTP transport (Claude.ai via Cloudflare).
 * Stateless mode: every POST /mcp spins up a fresh McpServer instance.
 */

const express = require('express');
const cors = require('cors');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { registerTools } = require('./register-tools');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', transport: 'streamable-http', mode: 'stateless', name: 'iron' });
});

app.post('/mcp', async (req, res) => {
  const server = new McpServer({
    name: 'iron',
    version: '1.0.0'
  });

  registerTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined // stateless
  });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', (req, res) => {
  res.status(405).json({ error: 'Method Not Allowed. Use POST for MCP requests.' });
});

app.delete('/mcp', (req, res) => {
  res.status(405).json({ error: 'Method Not Allowed. Stateless server does not support session deletion.' });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`IRON MCP (Streamable HTTP) listening on port ${PORT}`);
});
