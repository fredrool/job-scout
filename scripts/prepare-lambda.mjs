#!/usr/bin/env node
import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'dist/lambda/config');

await mkdir(target, { recursive: true });
await cp(resolve(root, 'config/companies.yaml'), resolve(target, 'companies.yaml'));
await cp(resolve(root, 'config/profile.yaml'), resolve(target, 'profile.yaml'));
