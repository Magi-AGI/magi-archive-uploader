import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  ARCHIVE_BUCKET: z.string().min(1),
  AWS_REGION: z.string().default('us-west-1'),

  FOUNDRY_VIDEO_PATH: z.string().min(1),
  DISCORD_SESSIONS_PATH: z.string().min(1),
  MATTERMOST_EXPORTS_PATH: z.string().min(1),

  LEDGER_PATH: z.string().min(1),

  FOUNDRY_VIDEO_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(7),
  DISCORD_SESSIONS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(7),
  MATTERMOST_EXPORTS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),

  STABILITY_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  MULTIPART_THRESHOLD: z.coerce.number().int().positive().default(100 * 1024 * 1024),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface SourceConfig {
  /** Stable identifier; used as S3 prefix and ledger key. */
  name: string;
  /** Local root directory to scan. */
  path: string;
  /** S3 prefix under the bucket. */
  s3Prefix: string;
  /** Days to keep local file after S3-verified upload. 0 = never delete locally. */
  retentionDays: number;
}

export interface AppConfig {
  bucket: string;
  region: string;
  ledgerPath: string;
  stabilityWindowSeconds: number;
  multipartThreshold: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  sources: SourceConfig[];
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const env = envSchema.parse(process.env);
  cached = {
    bucket: env.ARCHIVE_BUCKET,
    region: env.AWS_REGION,
    ledgerPath: env.LEDGER_PATH,
    stabilityWindowSeconds: env.STABILITY_WINDOW_SECONDS,
    multipartThreshold: env.MULTIPART_THRESHOLD,
    logLevel: env.LOG_LEVEL,
    sources: [
      {
        name: 'foundry-video',
        path: env.FOUNDRY_VIDEO_PATH,
        s3Prefix: 'foundry-video/',
        retentionDays: env.FOUNDRY_VIDEO_RETENTION_DAYS,
      },
      {
        name: 'discord-sessions',
        path: env.DISCORD_SESSIONS_PATH,
        s3Prefix: 'discord-sessions/',
        retentionDays: env.DISCORD_SESSIONS_RETENTION_DAYS,
      },
      {
        name: 'mattermost-exports',
        path: env.MATTERMOST_EXPORTS_PATH,
        s3Prefix: 'mattermost-exports/',
        retentionDays: env.MATTERMOST_EXPORTS_RETENTION_DAYS,
      },
    ],
  };
  return cached;
}
