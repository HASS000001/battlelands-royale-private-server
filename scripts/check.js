#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', '.git', 'backups']);
const jsFiles = [];
const jsonFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (entry.isFile()) {
      if (entry.name.endsWith('.js')) jsFiles.push(fullPath);
      if (entry.name.endsWith('.json')) jsonFiles.push(fullPath);
    }
  }
}

walk(root);
let failures = 0;
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures++;
    process.stderr.write(`${path.relative(root, file)}\n${result.stderr || result.stdout}`);
  }
}
for (const file of jsFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const requireFromFile = createRequire(file);
  for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    const expression = /require\(\s*['\"](\.[^'\"]+)['\"]\s*\)/g;
    let match;
    while ((match = expression.exec(line))) {
      try { requireFromFile.resolve(match[1]); }
      catch {
        failures++;
        process.stderr.write(`${path.relative(root, file)}:${lineIndex + 1}: unresolved local module ${match[1]}\n`);
      }
    }
  }
}
for (const file of jsonFiles) {
  try { JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    failures++;
    process.stderr.write(`${path.relative(root, file)}: ${error.message}\n`);
  }
}

const catalogPath = path.join(root, 'src/data/catalog.json');
try {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (!Array.isArray(catalog)) throw new Error('Expected a JSON array.');
  const ids = new Set();
  for (const item of catalog) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.ItemId !== 'string' || !item.ItemId.trim()) {
      throw new Error('Each entry must be an object with a non-empty ItemId.');
    }
    if (ids.has(item.ItemId)) throw new Error(`Duplicate ItemId: ${item.ItemId}`);
    ids.add(item.ItemId);
  }
} catch (error) {
  failures++;
  process.stderr.write(`src/data/catalog.json: ${error.message}\n`);
}

const gitignorePath = path.join(root, '.gitignore');
const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
if (!/^\.env$/m.test(gitignore) || !/^\.env\.\*$/m.test(gitignore) || !/^!\.env\.example$/m.test(gitignore)) {
  failures++;
  process.stderr.write('.gitignore must exclude local environment files while allowing .env.example.\n');
}


for (const [relativePath, expectedType] of [
  ['src/data/stores.json', 'object'],
  ['src/data/title_data.json', 'object'],
]) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Array.isArray(value) !== (expectedType === 'array')) {
      throw new Error(`Expected a JSON ${expectedType}.`);
    }
  } catch (error) {
    failures++;
    process.stderr.write(`${relativePath}: ${error.message}\n`);
  }
}

if (failures) {
  process.stderr.write(`\nValidation failed: ${failures} issue(s).\n`);
  process.exit(1);
}
console.log(`Validated ${jsFiles.length} JavaScript files and ${jsonFiles.length} JSON files.`);
