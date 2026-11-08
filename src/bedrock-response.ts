import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { coerceLlmEvaluation, type LlmEvaluation } from './domain.js';

export interface BedrockParseDiagnostics {
  stopReason?: string;
  textLength: number;
  contentBlocks: number;
  stage: 'ok' | 'no_text' | 'no_json' | 'json_parse' | 'schema';
  message?: string;
}

export interface BedrockParseResult {
  evaluation: LlmEvaluation;
  diagnostics: BedrockParseDiagnostics;
}

export function collectConverseText(output: ConverseCommandOutput): string {
  const blocks = output.output?.message?.content ?? [];
  const parts: string[] = [];
  for (const block of blocks) {
    if ('text' in block && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

export function extractJsonObject(text: string): string | undefined {
  const normalized = stripMarkdownFence(text.trim());
  if (normalized.startsWith('{') && normalized.endsWith('}')) {
    return normalized;
  }
  const start = normalized.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return normalized.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

export function parseConverseEvaluation(output: ConverseCommandOutput): BedrockParseResult {
  const stopReason = output.stopReason;
  const text = collectConverseText(output);
  const contentBlocks = output.output?.message?.content?.length ?? 0;
  const baseDiagnostics = {
    ...(stopReason ? { stopReason } : {}),
    textLength: text.length,
    contentBlocks,
  };

  if (!text) {
    throw createParseError({
      ...baseDiagnostics,
      stage: 'no_text',
      message: 'Bedrock returned no text response',
    });
  }

  const candidate = extractJsonObject(text);
  if (!candidate) {
    throw createParseError({
      ...baseDiagnostics,
      stage: 'no_json',
      message: 'Bedrock returned no JSON object',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    throw createParseError({
      ...baseDiagnostics,
      stage: 'json_parse',
      message: 'Bedrock returned invalid JSON',
    });
  }

  const coerced = coerceLlmEvaluation(parsed);
  if (!coerced.ok) {
    throw createParseError({
      ...baseDiagnostics,
      stage: 'schema',
      message: coerced.error,
    });
  }

  return {
    evaluation: coerced.evaluation,
    diagnostics: { ...baseDiagnostics, stage: 'ok' },
  };
}

export class BedrockParseError extends Error {
  readonly diagnostics: BedrockParseDiagnostics;

  constructor(message: string, diagnostics: BedrockParseDiagnostics) {
    super(message);
    this.name = 'BedrockParseError';
    this.diagnostics = diagnostics;
  }
}

function createParseError(diagnostics: BedrockParseDiagnostics): BedrockParseError {
  return new BedrockParseError(diagnostics.message ?? 'Bedrock response parse failed', diagnostics);
}

function stripMarkdownFence(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  return text;
}
