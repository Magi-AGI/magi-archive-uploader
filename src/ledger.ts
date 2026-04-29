import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

export interface LedgerEntry {
  source: string;
  localPath: string;        // relative to source root
  sizeBytes: number;
  mtime: number;            // ms epoch of file mtime at upload time
  sha256: string;
  s3Key: string;
  uploadedAt: number;       // ms epoch
  verifiedAt: number | null;
  localDeletedAt: number | null;
}

interface Row {
  source: string;
  local_path: string;
  size_bytes: number;
  mtime: number;
  sha256: string;
  s3_key: string;
  uploaded_at: number;
  verified_at: number | null;
  local_deleted_at: number | null;
}

function rowToEntry(r: Row): LedgerEntry {
  return {
    source: r.source,
    localPath: r.local_path,
    sizeBytes: r.size_bytes,
    mtime: r.mtime,
    sha256: r.sha256,
    s3Key: r.s3_key,
    uploadedAt: r.uploaded_at,
    verifiedAt: r.verified_at,
    localDeletedAt: r.local_deleted_at,
  };
}

export class Ledger {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS uploads (
        source TEXT NOT NULL,
        local_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        s3_key TEXT NOT NULL,
        uploaded_at INTEGER NOT NULL,
        verified_at INTEGER,
        local_deleted_at INTEGER,
        PRIMARY KEY (source, local_path)
      );
      CREATE INDEX IF NOT EXISTS idx_verified_at ON uploads(verified_at);
    `);
  }

  get(source: string, localPath: string): LedgerEntry | null {
    const row = this.db.prepare(
      `SELECT * FROM uploads WHERE source = ? AND local_path = ?`
    ).get(source, localPath) as Row | undefined;
    return row ? rowToEntry(row) : null;
  }

  recordUpload(entry: Omit<LedgerEntry, 'verifiedAt' | 'localDeletedAt'>): void {
    this.db.prepare(`
      INSERT INTO uploads (source, local_path, size_bytes, mtime, sha256, s3_key, uploaded_at, verified_at, local_deleted_at)
      VALUES (@source, @local_path, @size_bytes, @mtime, @sha256, @s3_key, @uploaded_at, NULL, NULL)
      ON CONFLICT(source, local_path) DO UPDATE SET
        size_bytes = excluded.size_bytes,
        mtime = excluded.mtime,
        sha256 = excluded.sha256,
        s3_key = excluded.s3_key,
        uploaded_at = excluded.uploaded_at,
        verified_at = NULL,
        local_deleted_at = NULL
    `).run({
      source: entry.source,
      local_path: entry.localPath,
      size_bytes: entry.sizeBytes,
      mtime: entry.mtime,
      sha256: entry.sha256,
      s3_key: entry.s3Key,
      uploaded_at: entry.uploadedAt,
    });
  }

  markVerified(source: string, localPath: string, verifiedAt: number): void {
    this.db.prepare(
      `UPDATE uploads SET verified_at = ? WHERE source = ? AND local_path = ?`
    ).run(verifiedAt, source, localPath);
  }

  markLocalDeleted(source: string, localPath: string, deletedAt: number): void {
    this.db.prepare(
      `UPDATE uploads SET local_deleted_at = ? WHERE source = ? AND local_path = ?`
    ).run(deletedAt, source, localPath);
  }

  /** Returns verified-but-not-yet-deleted entries older than the cutoff. */
  cleanupCandidates(source: string, verifiedBefore: number): LedgerEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM uploads
      WHERE source = ?
        AND verified_at IS NOT NULL
        AND verified_at < ?
        AND local_deleted_at IS NULL
    `).all(source, verifiedBefore) as Row[];
    return rows.map(rowToEntry);
  }

  close(): void {
    this.db.close();
  }
}
