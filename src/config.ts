import * as path from "path";

export interface Config {
  workspaceRoot: string;
  backupRoot: string;
  timeoutMs: number;
  maxFileSizeBytes: number;
}

export function loadConfig(): Config {
  const workspaceRoot = path.resolve(
    process.env.MCP_EDIT_ROOT || process.cwd()
  );

  const backupRoot = path.resolve(
    process.env.MCP_EDIT_BACKUP_DIR ||
      path.join(workspaceRoot, ".editor")
  );

  const timeoutRaw = process.env.MCP_EDIT_TIMEOUT_MS || "600000";
  const timeoutMs = Number.parseInt(timeoutRaw, 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 60_000) {
    throw new Error(
      `MCP_EDIT_TIMEOUT_MS must be a number >= 60000, got: ${timeoutRaw}`
    );
  }

  const sizeRaw = process.env.MCP_EDIT_MAX_FILE_SIZE || "10485760";
  const maxFileSizeBytes = Number.parseInt(sizeRaw, 10);
  if (!Number.isFinite(maxFileSizeBytes) || maxFileSizeBytes < 1024) {
    throw new Error(
      `MCP_EDIT_MAX_FILE_SIZE must be a number >= 1024, got: ${sizeRaw}`
    );
  }

  return { workspaceRoot, backupRoot, timeoutMs, maxFileSizeBytes };
}