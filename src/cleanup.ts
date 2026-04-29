import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from './config.js';
import { Ledger } from './ledger.js';
import { logger } from './logger.js';

interface CleanupStats {
  considered: number;
  deleted: number;
  skippedMissing: number;
  failed: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function runCleanupPass(config: AppConfig, ledger: Ledger): CleanupStats {
  const stats: CleanupStats = { considered: 0, deleted: 0, skippedMissing: 0, failed: 0 };
  const now = Date.now();

  for (const source of config.sources) {
    if (source.retentionDays <= 0) {
      logger.debug(`Source ${source.name}: retention disabled, skipping cleanup`);
      continue;
    }
    const cutoff = now - source.retentionDays * DAY_MS;
    const candidates = ledger.cleanupCandidates(source.name, cutoff);
    stats.considered += candidates.length;

    for (const entry of candidates) {
      const absPath = path.join(source.path, entry.localPath);
      try {
        if (!fs.existsSync(absPath)) {
          logger.debug(`Local already gone (manual delete?): ${absPath}`);
          ledger.markLocalDeleted(source.name, entry.localPath, now);
          stats.skippedMissing++;
          continue;
        }
        fs.unlinkSync(absPath);
        ledger.markLocalDeleted(source.name, entry.localPath, now);
        stats.deleted++;
        logger.info(`Deleted local ${source.name}/${entry.localPath} (verified ${Math.round((now - (entry.verifiedAt ?? 0)) / DAY_MS)}d ago)`);
      } catch (err) {
        stats.failed++;
        logger.error(`Cleanup FAILED for ${source.name}/${entry.localPath}:`, err as Error);
      }
    }
  }

  return stats;
}
