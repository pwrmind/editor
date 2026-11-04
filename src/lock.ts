import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { StructuredError, ErrorCode } from "./errors.js";

export interface LockInfo {
  pid: number;
  host: string;
  transactionId: string;
  createdAt: number;
  heartbeatAt: number;
}

const HOST = os.hostname();
const MAX_ACQUIRE_ATTEMPTS = 3;

/**
 * Cross-process advisory lock, one per file.
 * Stale locks (heartbeat older than timeout) are taken over.
 * Locks are also taken over if their pid == our pid (we crashed).
 */
export class LockManager {
  private locksDir: string;
  private timeoutMs: number;

  constructor(locksDir: string, timeoutMs: number) {
    this.locksDir = locksDir;
    this.timeoutMs = timeoutMs;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.locksDir, { recursive: true });
  }

  private lockPath(fileHash: string): string {
    return path.join(this.locksDir, `${fileHash}.lock`);
  }

  async acquire(fileHash: string, transactionId: string): Promise<void> {
    await this.init();
    const lp = this.lockPath(fileHash);

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      try {
        const info: LockInfo = {
          pid: process.pid,
          host: HOST,
          transactionId,
          createdAt: Date.now(),
          heartbeatAt: Date.now(),
        };
        const handle = await fs.open(lp, "wx");
        try {
          await handle.writeFile(JSON.stringify(info, null, 2), "utf-8");
        } finally {
          await handle.close();
        }
        return;
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;

        let existing: LockInfo | null = null;
        try {
          existing = JSON.parse(await fs.readFile(lp, "utf-8"));
        } catch {
          await fs.unlink(lp).catch(() => {});
          continue;
        }

        // Stale — take over
        if (
          !existing ||
          existing.heartbeatAt + this.timeoutMs < Date.now()
        ) {
          await fs.unlink(lp).catch(() => {});
          continue;
        }

        // Same pid (we crashed and restarted) — take over
        if (existing.pid === process.pid) {
          await fs.unlink(lp).catch(() => {});
          continue;
        }

        // Another live process
        throw new StructuredError(
          ErrorCode.TRANSACTION_CONFLICT,
          `File is locked by another process (pid ${existing.pid} on ${existing.host}).`,
          "Wait for the other session to commit or rollback, then retry.",
          {
            holderPid: existing.pid,
            holderHost: existing.host,
            holderTransactionId: existing.transactionId,
            retryAfterMs: 5000,
          }
        );
      }
    }

    throw new StructuredError(
      ErrorCode.TRANSACTION_CONFLICT,
      "Failed to acquire file lock after 3 attempts.",
      "Try again in a few seconds.",
      { fileHash }
    );
  }

  async release(fileHash: string): Promise<void> {
    const lp = this.lockPath(fileHash);
    try {
      const raw = await fs.readFile(lp, "utf-8");
      const info: LockInfo = JSON.parse(raw);
      if (info.pid === process.pid) {
        await fs.unlink(lp);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Update heartbeat. Returns true if this process still owns the lock.
   */
  async heartbeat(fileHash: string): Promise<boolean> {
    const lp = this.lockPath(fileHash);
    try {
      const raw = await fs.readFile(lp, "utf-8");
      const info: LockInfo = JSON.parse(raw);
      if (info.pid !== process.pid) return false;
      info.heartbeatAt = Date.now();
      await fs.writeFile(lp, JSON.stringify(info, null, 2), "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  async cleanupStale(): Promise<string[]> {
    const removed: string[] = [];
    try {
      const files = await fs.readdir(this.locksDir);
      for (const f of files) {
        if (!f.endsWith(".lock")) continue;
        const lp = path.join(this.locksDir, f);
        try {
          const raw = await fs.readFile(lp, "utf-8");
          const info: LockInfo = JSON.parse(raw);
          if (info.heartbeatAt + this.timeoutMs < Date.now()) {
            await fs.unlink(lp);
            removed.push(lp);
          }
        } catch {
          await fs.unlink(lp).catch(() => {});
          removed.push(lp);
        }
      }
    } catch {
      // No locks dir
    }
    return removed;
  }
}