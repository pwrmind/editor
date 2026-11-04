import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { ServerState } from "./state.js";

async function main(): Promise<void> {
  const config = loadConfig();
  console.error("[mcp-edit] config:");
  console.error(`  workspaceRoot    = ${config.workspaceRoot}`);
  console.error(`  backupRoot       = ${config.backupRoot}`);
  console.error(`  timeoutMs        = ${config.timeoutMs}`);
  console.error(`  maxFileSizeBytes = ${config.maxFileSizeBytes}`);

  const state = new ServerState(config);
  const server = createServer(state);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    "[mcp-edit] running (stdio). Tools: read_file, search_file, edit_file."
  );

  const shutdown = async () => {
    console.error("[mcp-edit] shutting down…");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[mcp-edit] fatal:", err);
  process.exit(1);
});