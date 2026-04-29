#!/usr/bin/env node
import { getConfig } from './config.js';
import { Ledger } from './ledger.js';
import { logger, setLogLevel } from './logger.js';
import { runUploadPass } from './uploader.js';
import { runCleanupPass } from './cleanup.js';

interface CliOptions {
  uploadOnly: boolean;
  cleanupOnly: boolean;
  dryRunCleanup: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { uploadOnly: false, cleanupOnly: false, dryRunCleanup: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--upload-only') opts.uploadOnly = true;
    else if (arg === '--cleanup-only') opts.cleanupOnly = true;
    else if (arg === '--dry-run-cleanup') opts.dryRunCleanup = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  if (opts.uploadOnly && opts.cleanupOnly) {
    console.error('Cannot combine --upload-only and --cleanup-only');
    process.exit(2);
  }
  return opts;
}

function printHelp(): void {
  console.log(`magi-archive-uploader

Usage:
  magi-archive-uploader              # upload pass + cleanup pass
  magi-archive-uploader --upload-only
  magi-archive-uploader --cleanup-only
  magi-archive-uploader --dry-run-cleanup   # report what cleanup would delete (no-op)

Configuration via .env (see .env.example).`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const config = getConfig();
  setLogLevel(config.logLevel);

  logger.info(`magi-archive-uploader starting (bucket: ${config.bucket}, region: ${config.region})`);
  const ledger = new Ledger(config.ledgerPath);

  try {
    if (!opts.cleanupOnly) {
      const upStats = await runUploadPass(config, ledger);
      logger.info(`Upload pass: scanned=${upStats.scanned} already=${upStats.alreadyUploaded} uploaded=${upStats.uploaded} verified=${upStats.verified} failed=${upStats.failed}`);
    }

    if (!opts.uploadOnly) {
      if (opts.dryRunCleanup) {
        // Report counts without deleting.
        const now = Date.now();
        for (const source of config.sources) {
          if (source.retentionDays <= 0) continue;
          const cutoff = now - source.retentionDays * 24 * 60 * 60 * 1000;
          const candidates = ledger.cleanupCandidates(source.name, cutoff);
          logger.info(`[dry-run] ${source.name}: ${candidates.length} file(s) would be deleted (retention=${source.retentionDays}d)`);
        }
      } else {
        const clStats = runCleanupPass(config, ledger);
        logger.info(`Cleanup pass: considered=${clStats.considered} deleted=${clStats.deleted} missing=${clStats.skippedMissing} failed=${clStats.failed}`);
      }
    }
  } finally {
    ledger.close();
  }
}

main().catch((err) => {
  logger.error('Fatal:', err);
  process.exit(1);
});
