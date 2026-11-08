import { describe, expect, it } from 'vitest';
import { parseEnvironment } from '../src/config.js';

describe('environment configuration', () => {
  it('validates recipient and exposes safe defaults', () => {
    const config = parseEnvironment({ NOTIFICATION_EMAIL: 'alerts@example.com' });
    expect(config.NOTIFICATION_EMAIL).toBe('alerts@example.com');
    expect(config.BEDROCK_MODEL_ID).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(config.MOCK_MODE).toBe(true);
  });

  it('defaults NOTIFICATION_EMAIL for local CLI commands when unset', () => {
    const config = parseEnvironment({});
    expect(config.NOTIFICATION_EMAIL).toBe('alerts@example.com');
  });

  it('rejects invalid recipients and mock production mode', () => {
    expect(() => parseEnvironment({ NOTIFICATION_EMAIL: 'not-an-email' })).toThrow();
    expect(() =>
      parseEnvironment({
        NOTIFICATION_EMAIL: 'alerts@example.com',
        NODE_ENV: 'production',
        MOCK_MODE: 'true',
      }),
    ).toThrow(/MOCK_MODE/);
  });
});
