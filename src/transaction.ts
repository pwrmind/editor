import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { ErrorCode, StructuredError } from "./errors.js";
import { atomicWriteFile, normalizeEol, sha256 } from "./fs.js";
import { formatUnifiedDiff } from "./edits.js";
import { LockManager } from "./lock.js";

export interface TransactionRecord {
  transactionId: string;
  filePath: string;
  fileHash: string;
  backupPath: string;
  snapshotsDir: string;
  pointer: number;
  snapshotCount: number;
  originalHash: string;
  currentHash: string;
  createdAt: number;
  lastEditedAt: number;
}

interface StoreData {
  version: 2;
  transactions: TransactionRecord[];
}

const STORE_VERSION = 2;

export class TransactionManager {
  private state: StoreData = { version: STORE_VERSION, transactions: [] };
  private statePath: string;
  private backupRoot: string;
  private timeoutMs: number;
  private locks: LockManager;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(opts: { backupRoot: string; timeoutMs: number }) {
    this.backupRoot = opts.backupRoot;
    this.timeoutMs = opts.timeoutMs;
    this.statePath = path.join(opts.backupRoot, "state.json");
    this.locks = new LockManager(
      path.join(opts.backupRoot, "locks"),
      opts.timeoutMs
    );
  }

  async init(): Promise<void> {
    await fs.mkdir(this.backupRoot, { recursive: true });
    await fs.mkdir(path.join(this.backupRoot, "backups"), { recursive: true });
    await this.locks.init();
    await this.load();
    await this.verifyOnStartup();
    await this.scanOrphans();
  }

  async shutdown(): Promise<void> {
    await this.saveQueue.catch(() => {});
  }

  // ---- persistence ----

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.version !== STORE_VERSION) {
        console.error(
          `[editor] state.json version ${parsed?.version} != ${STORE_VERSION}; ` +
            `starting with empty state. Orphaned backups will be logged and left on disk.`
        );
        return;
      }
      if (!Array.isArray(parsed.transactions)) {
        throw new Error("state.json: transactions is not an array");
      }
      this.state = parsed;
    } catch (err: any) {
      if (err.code === "ENOENT") return;
      console.error("[editor] failed to load state.json:", err.message);
      try {
        const corrupt = this.statePath + ".corrupt-" + Date.now();
        await fs.rename(this.statePath, corrupt);
        console.error(`[editor] corrupt state.json moved to ${corrupt}`);
      } catch {
        // ignore
      }
    }
  }

  private async save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.saveQueue = this.saveQueue
      .then(async () => {
        await fs.mkdir(path.dirname(this.statePath), { recursive: true });
        await atomicWriteFile(this.statePath, snapshot);
      })
      .catch((err) => {
        console.error("[editor] failed to save state.json:", err);
      });
    await this.saveQueue;
  }

  private async verifyOnStartup(): Promise<void> {
    const toRemove = new Set<string>();

    for (const t of this.state.transactions) {
      const backupOk = await fileExists(t.backupPath);
      const fileOk = await fileExists(t.filePath);

      if (!backupOk) {
        console.error(
          `[editor] txn ${t.transactionId}: backup missing for ${t.filePath}; removing record (file untouched)`
        );
        toRemove.add(t.transactionId);
        continue;
      }

      if (!fileOk) {
        console.error(
          `[editor] txn ${t.transactionId}: file missing for ${t.filePath}; restoring from backup`
        );
        try {
          const raw = await fs.readFile(t.backupPath);
          await fs.mkdir(path.dirname(t.filePath), { recursive: true });
          await atomicWriteFile(t.filePath, raw.toString("utf-8"));
          await fs.rm(path.dirname(t.backupPath), { recursive: true }).catch(() => {});
        } catch (err: any) {
          console.error(`[editor] restore failed: ${err.message}`);
        }
        toRemove.add(t.transactionId);
        continue;
      }

      // Verify snapshotsDir + current pointer snapshot.
      if (t.snapshotCount > 0) {
        const dirOk = await dirExists(t.snapshotsDir);
        if (!dirOk) {
          console.error(
            `[editor] txn ${t.transactionId}: snapshotsDir missing for ${t.filePath}; removing record`
          );
          toRemove.add(t.transactionId);
          continue;
        }
        if (t.pointer > 0) {
          const p = path.join(t.snapshotsDir, pad(t.pointer));
          if (!(await fileExists(p))) {
            console.error(
              `[editor] txn ${t.transactionId}: snapshot[${t.pointer}] missing for ${t.filePath}; removing record`
            );
            toRemove.add(t.transactionId);
            continue;
          }
        }
      }

      // Disk vs currentHash.
      try {
        const stat = await fs.stat(t.filePath);
        if (stat.size <= 50 * 1024 * 1024) {
          const raw = await fs.readFile(t.filePath);
          const diskHash = sha256(raw);
          if (diskHash !== t.currentHash) {
            console.error(
              `[editor] txn ${t.transactionId}: ${t.filePath} changed externally ` +
                `(expected ${t.currentHash}, actual ${diskHash}). ` +
                `Transaction kept; use rollback_file to restore original.`
            );
          }
        }
      } catch {
        // ignore
      }
    }

    if (toRemove.size > 0) {
      this.state.transactions = this.state.transactions.filter(
        (t) => !toRemove.has(t.transactionId)
      );
      await this.save();
    }
  }

  private async scanOrphans(): Promise<void> {
    const backupsDir = path.join(this.backupRoot, "backups");
    try {
      const dirs = await fs.readdir(backupsDir);
      const known = new Set(this.state.transactions.map((t) => t.fileHash));
      for (const d of dirs) {
        if (!known.has(d)) {
          console.error(
            `[editor] orphaned backup directory: ${path.join(backupsDir, d)}`
          );
        }
      }
    } catch {
      // no backups dir
    }
  }

  // ---- queries ----

  get(filePath: string): TransactionRecord | undefined {
    return this.state.transactions.find((t) => t.filePath === filePath);
  }

  all(): TransactionRecord[] {
    return [...this.state.transactions];
  }

  // ---- paths ----

  private backupPathFor(filePath: string): {
    dir: string;
    backupPath: string;
    snapshotsDir: string;
    fileHash: string;
  } {
    const fileHash = createHash("sha256")
      .update(filePath)
      .digest("hex")
      .slice(0, 16);
    const dir = path.join(this.backupRoot, "backups", fileHash);
    return {
      dir,
      backupPath: path.join(dir, "original"),
      snapshotsDir: path.join(dir, "snapshots"),
      fileHash,
    };
  }

  // ---- applyEdit ----

  async applyEdit(opts: {
    filePath: string;
    originalContent: string;
    originalHash: string;
    newContent: string;
    newHash: string;
  }): Promise<TransactionRecord> {
    const existing = this.get(opts.filePath);
    if (!existing) return this.startTransaction(opts);
    return this.appendEdit(existing, opts.newContent, opts.newHash);
  }

  private async startTransaction(opts: {
    filePath: string;
    originalContent: string;
    originalHash: string;
    newContent: string;
    newHash: string;
  }): Promise<TransactionRecord> {
    const { dir, backupPath, snapshotsDir, fileHash } = this.backupPathFor(
      opts.filePath
    );
    const transactionId = `tx-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    await this.locks.acquire(fileHash, transactionId);

    try {
      // Race guard: re-read after acquiring lock.
      const raw = await fs.readFile(opts.filePath);
      const checkHash = sha256(raw);
      if (checkHash !== opts.originalHash) {
        throw new StructuredError(
          ErrorCode.STALE_CONTENT,
          "File changed between read and lock acquisition.",
          "Re-read the file (read_file) and retry with the fresh hash.",
          { expectedHash: opts.originalHash, actualHash: checkHash }
        );
      }

      await fs.mkdir(snapshotsDir, { recursive: true });
      await atomicWriteFile(backupPath, opts.originalContent);
      await atomicWriteFile(path.join(snapshotsDir, "0001"), opts.newContent);
      await atomicWriteFile(opts.filePath, opts.newContent);

      const record: TransactionRecord = {
        transactionId,
        filePath: opts.filePath,
        fileHash,
        backupPath,
        snapshotsDir,
        pointer: 1,
        snapshotCount: 1,
        originalHash: opts.originalHash,
        currentHash: opts.newHash,
        createdAt: Date.now(),
        lastEditedAt: Date.now(),
      };
      this.state.transactions.push(record);
      await this.save();
      return record;
    } catch (err) {
      await this.locks.release(fileHash).catch(() => {});
      await fs.rm(dir, { recursive: true }).catch(() => {});
      throw err;
    }
  }

  private async appendEdit(
    existing: TransactionRecord,
    newContent: string,
    newHash: string
  ): Promise<TransactionRecord> {
    const lockOk = await this.locks.heartbeat(existing.fileHash);
    if (!lockOk) {
      throw new StructuredError(
        ErrorCode.TRANSACTION_CONFLICT,
        "Transaction lock was lost to another process.",
        "Roll back to a known state, or re-read and start a new transaction.",
        { filePath: existing.filePath, transactionId: existing.transactionId }
      );
    }

    // Truncate redo history if we're not at the tip.
    if (existing.pointer < existing.snapshotCount) {
      for (let i = existing.pointer + 1; i <= existing.snapshotCount; i++) {
        await fs
          .unlink(path.join(existing.snapshotsDir, pad(i)))
          .catch(() => {});
      }
      existing.snapshotCount = existing.pointer;
    }

    const newIndex = existing.pointer + 1;
    await atomicWriteFile(
      path.join(existing.snapshotsDir, pad(newIndex)),
      newContent
    );
    await atomicWriteFile(existing.filePath, newContent);

    existing.pointer = newIndex;
    existing.snapshotCount = newIndex;
    existing.currentHash = newHash;
    existing.lastEditedAt = Date.now();
    await this.save();
    return existing;
  }

  // ---- undo / redo ----

  async undo(
    filePath: string,
    steps: number
  ): Promise<{
    transactionId: string;
    undoneSteps: number;
    pointer: number;
    snapshotCount: number;
    hash: string;
    diff: string;
  }> {
    const record = this.get(filePath);
    if (!record) {
      throw new StructuredError(
        ErrorCode.NO_ACTIVE_TRANSACTION,
        `No active transaction for ${filePath}.`,
        "Call edit_file first to start a transaction.",
        { path: filePath }
      );
    }
    if (record.pointer === 0) {
      throw new StructuredError(
        ErrorCode.UNDO_LIMIT,
        "Nothing to undo — already at the original state.",
        "Only edit_file advances the pointer; undo cannot go below 0.",
        { path: filePath, pointer: record.pointer }
      );
    }
    if (steps > record.pointer) {
      throw new StructuredError(
        ErrorCode.UNDO_LIMIT,
        `Requested ${steps} step(s) but only ${record.pointer} are available.`,
        `Reduce 'steps' to <= ${record.pointer}.`,
        { path: filePath, requested: steps, available: record.pointer }
      );
    }

    // External change guard.
    const diskRaw = await fs.readFile(record.filePath);
    const diskHash = sha256(diskRaw);
    if (diskHash !== record.currentHash) {
      throw new StructuredError(
        ErrorCode.STALE_CONTENT,
        "File changed externally since the last edit.",
        "Roll back the transaction (rollback_file) or re-read and start over.",
        { expectedHash: record.currentHash, actualHash: diskHash }
      );
    }

    const oldLf = normalizeEol(diskRaw.toString("utf-8"));
    const newPointer = record.pointer - steps;
    const restored =
      newPointer === 0
        ? (await fs.readFile(record.backupPath)).toString("utf-8")
        : (
            await fs.readFile(
              path.join(record.snapshotsDir, pad(newPointer))
            )
          ).toString("utf-8");
    const newHash = sha256(restored);

    await atomicWriteFile(record.filePath, restored);

    record.pointer = newPointer;
    record.currentHash = newHash;
    record.lastEditedAt = Date.now();
    await this.save();

    const newLf = normalizeEol(restored);
    const diff = formatUnifiedDiff(oldLf, newLf, path.basename(filePath));

    return {
      transactionId: record.transactionId,
      undoneSteps: steps,
      pointer: record.pointer,
      snapshotCount: record.snapshotCount,
      hash: newHash,
      diff,
    };
  }

  async redo(
    filePath: string,
    steps: number
  ): Promise<{
    transactionId: string;
    redoneSteps: number;
    pointer: number;
    snapshotCount: number;
    hash: string;
    diff: string;
  }> {
    const record = this.get(filePath);
    if (!record) {
      throw new StructuredError(
        ErrorCode.NO_ACTIVE_TRANSACTION,
        `No active transaction for ${filePath}.`,
        "Call edit_file first to start a transaction.",
        { path: filePath }
      );
    }
    const available = record.snapshotCount - record.pointer;
    if (available === 0) {
      throw new StructuredError(
        ErrorCode.UNDO_LIMIT,
        "Nothing to redo — already at the latest snapshot.",
        "Make a new edit_file call, or use undo_edit to go back first.",
        { path: filePath, pointer: record.pointer, snapshotCount: record.snapshotCount }
      );
    }
    if (steps > available) {
      throw new StructuredError(
        ErrorCode.UNDO_LIMIT,
        `Requested ${steps} step(s) but only ${available} are available.`,
        `Reduce 'steps' to <= ${available}.`,
        { path: filePath, requested: steps, available }
      );
    }

    // External change guard.
    const diskRaw = await fs.readFile(record.filePath);
    const diskHash = sha256(diskRaw);
    if (diskHash !== record.currentHash) {
      throw new StructuredError(
        ErrorCode.STALE_CONTENT,
        "File changed externally since the last edit.",
        "Roll back the transaction (rollback_file) or re-read and start over.",
        { expectedHash: record.currentHash, actualHash: diskHash }
      );
    }

    const oldLf = normalizeEol(diskRaw.toString("utf-8"));
    const newPointer = record.pointer + steps;
    const restored = (
      await fs.readFile(path.join(record.snapshotsDir, pad(newPointer)))
    ).toString("utf-8");
    const newHash = sha256(restored);

    await atomicWriteFile(record.filePath, restored);

    record.pointer = newPointer;
    record.currentHash = newHash;
    record.lastEditedAt = Date.now();
    await this.save();

    const newLf = normalizeEol(restored);
    const diff = formatUnifiedDiff(oldLf, newLf, path.basename(filePath));

    return {
      transactionId: record.transactionId,
      redoneSteps: steps,
      pointer: record.pointer,
      snapshotCount: record.snapshotCount,
      hash: newHash,
      diff,
    };
  }

  // ---- commit / rollback ----

  async commit(filePath: string): Promise<{
    transactionId: string;
    editsCount: number;
    durationMs: number;
    finalHash: string;
    diff: string;
  }> {
    const record = this.get(filePath);
    if (!record) {
      throw new StructuredError(
        ErrorCode.NO_ACTIVE_TRANSACTION,
        `No active transaction for ${filePath}.`,
        "Call edit_file first to start a transaction.",
        { path: filePath }
      );
    }

    const currentRaw = await fs.readFile(record.filePath);
    const currentHash = sha256(currentRaw);
    if (currentHash !== record.currentHash) {
      throw new StructuredError(
        ErrorCode.STALE_CONTENT,
        "File changed externally since the last edit.",
        "Roll back the transaction (rollback_file), or re-read and start over.",
        { expectedHash: record.currentHash, actualHash: currentHash }
      );
    }

    const backupRaw = await fs.readFile(record.backupPath);
    const originalLf = normalizeEol(backupRaw.toString("utf-8"));
    const currentLf = normalizeEol(currentRaw.toString("utf-8"));
    const diff = formatUnifiedDiff(
      originalLf,
      currentLf,
      path.basename(record.filePath)
    );

    await fs.rm(path.dirname(record.backupPath), { recursive: true }).catch(() => {});
    await this.locks.release(record.fileHash);

    this.state.transactions = this.state.transactions.filter(
      (t) => t.transactionId !== record.transactionId
    );
    await this.save();

    return {
      transactionId: record.transactionId,
      editsCount: record.pointer,
      durationMs: Date.now() - record.createdAt,
      finalHash: record.currentHash,
      diff,
    };
  }

  async rollback(filePath: string): Promise<{
    transactionId: string;
    editsReverted: number;
    restoredHash: string;
    diff: string;
  }> {
    const record = this.get(filePath);
    if (!record) {
      throw new StructuredError(
        ErrorCode.NO_ACTIVE_TRANSACTION,
        `No active transaction for ${filePath}.`,
        "Nothing to roll back.",
        { path: filePath }
      );
    }

    const backupRaw = await fs.readFile(record.backupPath);
    const backupText = backupRaw.toString("utf-8");
    const restoredHash = sha256(backupRaw);

    let currentLf = "";
    try {
      const currentRaw = await fs.readFile(record.filePath);
      currentLf = normalizeEol(currentRaw.toString("utf-8"));
    } catch {
      // file gone — diff against empty
    }

    const originalLf = normalizeEol(backupText);
    const diff = formatUnifiedDiff(
      currentLf,
      originalLf,
      path.basename(record.filePath)
    );

    await atomicWriteFile(record.filePath, backupText);
    await fs.rm(path.dirname(record.backupPath), { recursive: true }).catch(() => {});
    await this.locks.release(record.fileHash);

    this.state.transactions = this.state.transactions.filter(
      (t) => t.transactionId !== record.transactionId
    );
    await this.save();

    return {
      transactionId: record.transactionId,
      editsReverted: record.pointer,
      restoredHash,
      diff,
    };
  }

  // ---- cleanup ----

  async cleanupStale(): Promise<TransactionRecord[]> {
    const now = Date.now();
    const rolledBack: TransactionRecord[] = [];

    for (const t of [...this.state.transactions]) {
      if (now - t.lastEditedAt <= this.timeoutMs) continue;

      let diskHash: string | null = null;
      try {
        const raw = await fs.readFile(t.filePath);
        diskHash = sha256(raw);
      } catch {
        // file gone
      }

      if (diskHash !== t.currentHash) {
        console.error(
          `[editor] auto-rollback skipped for ${t.filePath}: ` +
            `disk hash differs (expected ${t.currentHash}, actual ${diskHash}). ` +
            `Manual rollback required.`
        );
        continue;
      }

      try {
        const backupRaw = await fs.readFile(t.backupPath);
        await atomicWriteFile(t.filePath, backupRaw.toString("utf-8"));
        await fs
          .rm(path.dirname(t.backupPath), { recursive: true })
          .catch(() => {});
        await this.locks.release(t.fileHash);

        this.state.transactions = this.state.transactions.filter(
          (x) => x.transactionId !== t.transactionId
        );
        rolledBack.push(t);
        console.error(
          `[editor] auto-rollback: ${t.filePath} ` +
            `(idle ${Math.round((now - t.lastEditedAt) / 1000)}s)`
        );
      } catch (err: any) {
        console.error(
          `[editor] auto-rollback failed for ${t.filePath}: ${err.message}`
        );
      }
    }

    if (rolledBack.length > 0) await this.save();
    await this.locks.cleanupStale();

    return rolledBack;
  }
}

// ---- helpers ----

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}