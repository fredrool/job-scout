import { Injectable } from '@nestjs/common';

export interface HttpClientOptions {
  timeoutMs: number;
  maxRetries: number;
  requestsPerSecond: number;
  maxResponseBytes?: number;
  baseBackoffMs?: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

@Injectable()
export class HttpClient {
  private nextRequestAt = 0;

  constructor(
    private readonly options: HttpClientOptions = {
      timeoutMs: 10_000,
      maxRetries: 3,
      requestsPerSecond: 5,
    },
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    private readonly random: () => number = Math.random,
  ) {}

  async getJson<T>(url: string, headers: Readonly<Record<string, string>> = {}): Promise<T> {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost') {
      throw new HttpError('Only HTTPS endpoints are allowed', undefined, url);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      await this.throttle();
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, this.options.timeoutMs);

      try {
        const response = await this.fetcher(url, {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': 'job-scout/1.0', ...headers },
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new HttpError(
            `HTTP ${String(response.status)} from ${parsedUrl.hostname}`,
            response.status,
            url,
          );
          if (!retryableStatuses.has(response.status) || attempt === this.options.maxRetries) {
            throw error;
          }
          lastError = error;
          await this.backoff(attempt, response.headers.get('retry-after'));
          continue;
        }
        const declaredLength = Number(response.headers.get('content-length'));
        const maximum = this.options.maxResponseBytes ?? 5_000_000;
        if (Number.isFinite(declaredLength) && declaredLength > maximum) {
          throw new HttpError('Response exceeds configured size limit', response.status, url);
        }
        const body = await readLimitedBody(response, maximum, url);
        return JSON.parse(body) as T;
      } catch (error) {
        lastError = error;
        if (
          error instanceof HttpError ||
          (error instanceof Error && error.name === 'AbortError') ||
          attempt === this.options.maxRetries
        ) {
          if (error instanceof HttpError || attempt === this.options.maxRetries) throw error;
        }
        await this.backoff(attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new HttpError('HTTP request failed');
  }

  private async throttle(): Promise<void> {
    const interval = 1_000 / this.options.requestsPerSecond;
    const now = Date.now();
    const wait = Math.max(0, this.nextRequestAt - now);
    this.nextRequestAt = Math.max(now, this.nextRequestAt) + interval;
    if (wait > 0) await this.sleep(wait);
  }

  private async backoff(attempt: number, retryAfter?: string | null): Promise<void> {
    const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN;
    const serverDelay = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 0;
    const exponential = (this.options.baseBackoffMs ?? 250) * 2 ** attempt;
    await this.sleep(Math.max(serverDelay, exponential * (0.5 + this.random() * 0.5)));
  }
}

async function readLimitedBody(response: Response, maximum: number, url: string): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new HttpError('Response exceeds configured size limit', response.status, url);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
