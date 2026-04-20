/**
 * IRON MCP server — stdio transport (Claude Desktop via SSH).
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { registerTools } = require('./register-tools');

const server = new McpServer({
  name: 'iron',
  version: '1.0.0'
});

registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
