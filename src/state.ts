import { Mutex } from "./fs.js";
import { Config } from "./config.js";
import { TransactionManager } from "./transaction.js";

/**
 * Per-process runtime state. Passed to tool handlers.
 * Holds config, per-file mutexes, and the TransactionManager.
 */
export class ServerState {
  private mutexes = new Map<string, Mutex>();
  readonly transactions: TransactionManager;

  constructor(readonly config: Config) {
    this.transactions = new TransactionManager({
      backupRoot: config.backupRoot,
      timeoutMs: config.timeoutMs,
    });
  }

  async init(): Promise<void> {
    await this.transactions.init();
  }

  async shutdown(): Promise<void> {
    await this.transactions.shutdown();
  }

  getMutex(filePath: string): Mutex {
    let m = this.mutexes.get(filePath);
    if (!m) {
      m = new Mutex();
      this.mutexes.set(filePath, m);
    }
    return m;
  }
}