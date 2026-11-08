#!/usr/bin/env node
/* global console, process */
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/restrict-template-expressions */
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const terraformDirectory = resolve(root, 'infra/terraform');
const artifact = resolve(root, '.artifacts/job-scout-lambda.zip');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const terraform = process.platform === 'win32' ? 'terraform.exe' : 'terraform';

function run(command, args, cwd = root) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

for (const script of ['lint', 'typecheck', 'test', 'build', 'package']) {
  await run(npm, script === 'test' ? ['test'] : ['run', script]);
}

await access(artifact);
await run(terraform, ['fmt', '-check', '-recursive'], terraformDirectory);
await run(terraform, ['init', '-backend=false', '-input=false'], terraformDirectory);
await run(terraform, ['validate'], terraformDirectory);

console.log('Deploy preparation passed. No cloud resources were changed.');
