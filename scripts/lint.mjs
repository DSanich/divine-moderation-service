import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const repoRoot = process.cwd();
const nodeBinary = process.execPath;
const syntaxTargets = [
  'generate-admin-hash.mjs',
  'vitest.config.mjs',
  'scripts',
  'src'
];
const htmlTargets = [
  'src/admin/dashboard.html',
  'src/admin/messages.html',
  'src/admin/swipe-review.html',
  'src/admin/login.html'
];

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectMjsFiles(targetPath) {
  const absolutePath = path.join(repoRoot, targetPath);
  if (!(await fileExists(absolutePath))) {
    return [];
  }

  const stat = await fs.stat(absolutePath);
  if (stat.isFile()) {
    return absolutePath.endsWith('.mjs') ? [absolutePath] : [];
  }

  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const relativeEntryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      return collectMjsFiles(relativeEntryPath);
    }
    return entry.name.endsWith('.mjs')
      ? [path.join(repoRoot, relativeEntryPath)]
      : [];
  }));

  return files.flat();
}

function runNodeCheck(filePath) {
  const result = spawnSync(nodeBinary, ['--check', filePath], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `node --check failed for ${filePath}`);
  }
}

async function lintHtmlInlineScripts(filePath) {
  const absolutePath = path.join(repoRoot, filePath);
  if (!(await fileExists(absolutePath))) {
    return;
  }

  const html = await fs.readFile(absolutePath, 'utf8');
  const matches = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];

  matches.forEach((match, index) => {
    const scriptBody = match[1];
    try {
      new vm.Script(scriptBody, { filename: `${filePath}#script${index + 1}` });
    } catch (error) {
      throw new Error(`${filePath} inline script ${index + 1}: ${error.message}`);
    }
  });
}

async function main() {
  const files = (await Promise.all(syntaxTargets.map(collectMjsFiles))).flat().sort();

  if (files.length === 0) {
    throw new Error('No .mjs files found for syntax checks');
  }

  for (const filePath of files) {
    runNodeCheck(filePath);
  }

  for (const filePath of htmlTargets) {
    await lintHtmlInlineScripts(filePath);
  }

  console.log(`Lint passed for ${files.length} module files and ${htmlTargets.length} HTML files.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
