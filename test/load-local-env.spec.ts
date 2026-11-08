import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLocalEnvFile } from '../src/load-local-env.js';

afterEach(() => {
  delete process.env.NOTIFICATION_EMAIL;
  process.env.EXISTING = undefined;
});

describe('loadLocalEnvFile', () => {
  it('loads unset keys from .env without overriding existing environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-scout-env-'));
    const path = join(dir, '.env');
    writeFileSync(path, 'NOTIFICATION_EMAIL=from-dotenv@example.com\nEXISTING=from-file\n', 'utf8');
    process.env.EXISTING = 'from-shell';
    delete process.env.NOTIFICATION_EMAIL;

    loadLocalEnvFile(path);

    expect(process.env.NOTIFICATION_EMAIL).toBe('from-dotenv@example.com');
    expect(process.env.EXISTING).toBe('from-shell');
  });
});
