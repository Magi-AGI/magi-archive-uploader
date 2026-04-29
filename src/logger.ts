type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let threshold: Level = 'info';

export function setLogLevel(level: Level): void {
  threshold = level;
}

function emit(level: Level, msg: string, ...args: unknown[]): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[threshold]) return;
  const ts = new Date().toISOString();
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`[${ts}] [${level.toUpperCase()}] ${msg}${args.length ? ' ' + args.map(formatArg).join(' ') : ''}\n`);
}

function formatArg(a: unknown): string {
  if (a instanceof Error) return `${a.message}${a.stack ? '\n' + a.stack : ''}`;
  if (typeof a === 'object') {
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  return String(a);
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => emit('debug', msg, ...args),
  info: (msg: string, ...args: unknown[]) => emit('info', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => emit('warn', msg, ...args),
  error: (msg: string, ...args: unknown[]) => emit('error', msg, ...args),
};
