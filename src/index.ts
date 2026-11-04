import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { ServerState } from "./state.js";

async function main(): Promise<void> {
  const config = loadConfig();
  console.error("[editor] config:");
  console.error(`  workspaceRoot    = ${config.workspaceRoot}`);
  console.error(`  backupRoot       = ${config.backupRoot}`);
  console.error(`  timeoutMs        = ${config.timeoutMs}`);
  console.error(`  maxFileSizeBytes = ${config.maxFileSizeBytes}`);

  const state = new ServerState(config);
  await state.init();

  const cleanupTimer = setInterval(() => {
    state.transactions.cleanupStale().catch((err) => {
      console.error("[editor] cleanup error:", err);
    });
  }, 30_000);
  cleanupTimer.unref();

  const server = createServer(state);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    "[editor] running (stdio). Tools: read_file, search_file, edit_file, " +
      "commit_file, rollback_file, list_transactions."
  );

  const shutdown = async () => {
    console.error("[editor] shutting down…");
    clearInterval(cleanupTimer);
    await state.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[editor] fatal:", err);
  process.exit(1);
});