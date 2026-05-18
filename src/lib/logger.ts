const SECRET_KEYS = ['password', 'token', 'accesstoken', 'cookie', 'jwk', 'secret', 'csrf', 'jsessionid', 'liat', 'apppassword'];

function redact(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const lower = k.toLowerCase().replace(/[_-]/g, '');
    out[k] = SECRET_KEYS.some((s) => lower.includes(s)) ? '[REDACTED]' : redact(v);
  }
  return out;
}

export const logger = {
  info: (...args: unknown[]) => console.info('[CrossPosty]', ...args.map(redact)),
  warn: (...args: unknown[]) => console.warn('[CrossPosty]', ...args.map(redact)),
  error: (...args: unknown[]) => console.error('[CrossPosty]', ...args.map(redact)),
  debug: (...args: unknown[]) => console.debug('[CrossPosty]', ...args.map(redact)),
};
