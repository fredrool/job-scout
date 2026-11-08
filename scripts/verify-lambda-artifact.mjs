#!/usr/bin/env node
/* global console */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const artifact = await readFile(resolve(root, '.artifacts/job-scout-lambda.zip'));
const names = [];
let offset = 0;
while (offset + 30 <= artifact.length && artifact.readUInt32LE(offset) === 0x04034b50) {
  const compressedSize = artifact.readUInt32LE(offset + 18);
  const nameLength = artifact.readUInt16LE(offset + 26);
  const extraLength = artifact.readUInt16LE(offset + 28);
  const name = artifact.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
  names.push(name);
  offset += 30 + nameLength + extraLength + compressedSize;
}

for (const required of [
  'index.js',
  'package.json',
  'config/companies.yaml',
  'config/job-boards.yaml',
  'config/profile.yaml',
]) {
  if (!names.includes(required)) throw new Error(`Lambda artifact is missing ${required}`);
}

const bundle = await readFile(resolve(root, 'dist/lambda/index.js'), 'utf8');
if (/(?:from\s+|import\()["']@aws-sdk\//.test(bundle)) {
  throw new Error('Lambda bundle contains an unresolved AWS SDK import');
}

await import(
  `${new URL('../dist/lambda/index.js', import.meta.url).href}?verify=${String(Date.now())}`
);
console.log(
  `Verified Lambda artifact with ${String(names.length)} files and bundled runtime dependencies.`,
);
