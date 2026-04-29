import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, SourceConfig } from './config.js';
import { Ledger } from './ledger.js';
import { logger } from './logger.js';
import { sha256OfFile, uploadFile, verifyUpload } from './s3.js';

interface Candidate {
  source: SourceConfig;
  absPath: string;
  relPath: string;
  size: number;
  mtimeMs: number;
}

/** Walk a directory and yield regular files. Skips dotfiles. */
function* walk(root: string, rel = ''): Generator<{ abs: string; rel: string }> {
  const here = path.join(root, rel);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(here, { withFileTypes: true });
  } catch (err) {
    logger.warn(`Cannot read ${here}: ${(err as Error).message}`);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = path.join(root, childRel);
    if (entry.isDirectory()) {
      yield* walk(root, childRel);
    } else if (entry.isFile()) {
      yield { abs: childAbs, rel: childRel };
    }
  }
}

function gatherCandidates(config: AppConfig): Candidate[] {
  const out: Candidate[] = [];
  const stabilityCutoff = Date.now() - config.stabilityWindowSeconds * 1000;

  for (const source of config.sources) {
    if (!fs.existsSync(source.path)) {
      logger.debug(`Source path does not exist, skipping: ${source.path}`);
      continue;
    }
    let count = 0;
    for (const { abs, rel } of walk(source.path)) {
      let stat: fs.Stats;
      try { stat = fs.statSync(abs); } catch { continue; }
      if (stat.mtimeMs > stabilityCutoff) {
        logger.debug(`Skipping young file (mtime within stability window): ${abs}`);
        continue;
      }
      out.push({
        source,
        absPath: abs,
        relPath: rel,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      count++;
    }
    logger.debug(`Source ${source.name}: ${count} candidate file(s) past stability window`);
  }
  return out;
}

interface UploadStats {
  scanned: number;
  alreadyUploaded: number;
  uploaded: number;
  verified: number;
  failed: number;
}

export async function runUploadPass(config: AppConfig, ledger: Ledger): Promise<UploadStats> {
  const stats: UploadStats = { scanned: 0, alreadyUploaded: 0, uploaded: 0, verified: 0, failed: 0 };
  const candidates = gatherCandidates(config);
  stats.scanned = candidates.length;

  for (const c of candidates) {
    const existing = ledger.get(c.source.name, c.relPath);
    // Skip if already uploaded AND mtime+size unchanged. Re-uploads happen if file was modified.
    if (existing && existing.verifiedAt && existing.sizeBytes === c.size && existing.mtime === Math.floor(c.mtimeMs)) {
      stats.alreadyUploaded++;
      continue;
    }

    const s3Key = c.source.s3Prefix + c.relPath;
    logger.info(`Uploading ${c.source.name}/${c.relPath} (${c.size} bytes) -> s3://${config.bucket}/${s3Key}`);

    try {
      const sha256 = await sha256OfFile(c.absPath);
      const { uploadedAt } = await uploadFile({
        bucket: config.bucket,
        region: config.region,
        s3Key,
        filePath: c.absPath,
        sha256Hex: sha256,
        multipartThreshold: config.multipartThreshold,
      });
      ledger.recordUpload({
        source: c.source.name,
        localPath: c.relPath,
        sizeBytes: c.size,
        mtime: Math.floor(c.mtimeMs),
        sha256,
        s3Key,
        uploadedAt,
      });
      stats.uploaded++;

      const verifyResult = await verifyUpload({
        bucket: config.bucket,
        region: config.region,
        s3Key,
        expectedSha256Hex: sha256,
        expectedSize: c.size,
      });
      if (verifyResult.ok) {
        ledger.markVerified(c.source.name, c.relPath, Date.now());
        stats.verified++;
        logger.info(`Verified ${c.source.name}/${c.relPath}`);
      } else {
        stats.failed++;
        logger.error(`Verify FAILED for ${c.source.name}/${c.relPath}: ${verifyResult.reason}`);
      }
    } catch (err) {
      stats.failed++;
      logger.error(`Upload FAILED for ${c.source.name}/${c.relPath}:`, err as Error);
    }
  }

  return stats;
}
