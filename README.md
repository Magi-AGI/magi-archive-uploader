# magi-archive-uploader

Uploads session media to S3 with verify-then-delete retention.

Sources:
- **foundry-video** — Foundry VTT screen captures (`magi-assistant-foundry/data/video/*.webm`)
- **discord-sessions** — Discord voice/transcript bundles (`magi-assistant-discord/data/sessions/<uuid>/...`)
- **mattermost-exports** — Mattermost conversation export bundles

## Flow

Every run does up to two passes:

1. **Upload pass** — walk each source, find files past the stability window (default 5 min since last write) that aren't already in the local SQLite ledger as verified-uploaded. SHA-256 the file, upload to S3 (multipart for files >100 MB), HEAD the result, compare size + sha256 metadata, mark verified.
2. **Cleanup pass** — delete local files whose ledger entry is verified AND verified-at is older than the per-source retention window. Mattermost exports default to never-delete (retention 0).

The ledger lives in SQLite, default `~/.local/share/magi-archive-uploader/ledger.sqlite`. It survives restarts so we don't re-upload or re-list S3 every run.

## Configuration

Copy `.env.example` to `.env` and edit. Key settings:

| Var | Default | Meaning |
| --- | --- | --- |
| `ARCHIVE_BUCKET` | (required) | S3 bucket name |
| `AWS_REGION` | `us-west-1` | |
| `FOUNDRY_VIDEO_RETENTION_DAYS` | `7` | Days to keep local foundry video after S3-verified |
| `DISCORD_SESSIONS_RETENTION_DAYS` | `7` | Days to keep local discord sessions after S3-verified |
| `MATTERMOST_EXPORTS_RETENTION_DAYS` | `0` (never delete) | |
| `STABILITY_WINDOW_SECONDS` | `300` | Skip files modified in the last N seconds |
| `MULTIPART_THRESHOLD` | `104857600` (100 MB) | Files larger than this use multipart upload |

AWS credentials come from the standard provider chain (instance role, env, `~/.aws/credentials`). On the EC2 host we rely on the instance role `magi-archive-prod-role` having `MagiArchiveSessionArchivesAccess` attached (PutObject/GetObject/ListBucket/AbortMultipartUpload — no DeleteObject).

## CLI

```
npm run dev                       # upload + cleanup, dev mode (tsx)
node dist/index.js                # upload + cleanup, prod mode
node dist/index.js --upload-only  # skip cleanup pass
node dist/index.js --cleanup-only # skip upload pass
node dist/index.js --dry-run-cleanup  # report what cleanup would delete, no-op
```

## Deploying as systemd timer

```
sudo cp scripts/magi-archive-uploader.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now magi-archive-uploader.timer
systemctl list-timers magi-archive-uploader.timer
journalctl -u magi-archive-uploader.service -f
```

The timer runs every 30 minutes plus 5 minutes after boot. Adjust in `magi-archive-uploader.timer`.

## Verification design

For single-part PUT, S3's ETag is the MD5 of the content. For multipart, ETag is opaque (hash of part hashes plus part count). To make verification uniform across both paths we:

1. Compute SHA-256 of the local file before upload
2. Pass it as object metadata `sha256-hex` on the PUT/multipart
3. After upload, HEAD the object and compare:
   - `Content-Length` against local size
   - `Metadata['sha256-hex']` against the computed digest

Mismatch logs an error and leaves the ledger entry unverified — next run will re-upload.

## Safety: no DeleteObject

The IAM policy attached to the instance role grants no `s3:DeleteObject`. Local-side cleanup uses filesystem `unlink`. S3-side aging is handled by lifecycle rules (Standard → Standard-IA → Glacier Deep Archive). This means accidental local deletion of a verified file before retention elapses is recoverable from S3.
