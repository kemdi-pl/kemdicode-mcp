#!/usr/bin/env bun
/**
 * Add GPL-3.0 License Headers to Source Files
 *
 * This script ensures all TypeScript files in src/ and __tests__/ have
 * the correct full GPL-3.0 license header. It handles three cases:
 *   1. Missing header — prepends full header
 *   2. Incomplete header (short @license tag or truncated GPL) — replaces with full header
 *   3. Complete header — skips
 *
 * Usage: bun scripts/add-license-headers.ts [--dry-run]
 */

import { readdir, readFile, writeFile } from 'fs/promises';
import { join, relative } from 'path';

const LICENSE_HEADER = `/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

`;

const SHEBANG_REGEX = /^#!.*\n/;

// Full header fingerprint — if this line is present, header is complete
const FULL_HEADER_MARKER = 'along with this program';

// Patterns matching incomplete license headers to replace:
// 1. Short header: /** ... KemdiCode MCP Server ... @license GPL-3.0 ... */
// 2. Truncated header: /** ... KemdiCode MCP Server ... any later version. */
//    (missing WARRANTY disclaimer)
const INCOMPLETE_HEADER_REGEX =
  /^(#!.*\n)?\/\*\*\s*\n \* KemdiCode MCP Server[\s\S]*?\*\/\n+/;

async function* walkDir(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules and dist
      if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        yield* walkDir(path);
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield path;
    }
  }
}

type ProcessResult = 'skipped' | 'added' | 'replaced';

async function processFile(filePath: string, dryRun: boolean): Promise<ProcessResult> {
  const content = await readFile(filePath, 'utf-8');

  // Already has complete header
  if (content.includes(FULL_HEADER_MARKER) && content.includes('KemdiCode MCP Server')) {
    return 'skipped';
  }

  // Check for incomplete header to replace
  const incompleteMatch = content.match(INCOMPLETE_HEADER_REGEX);
  if (incompleteMatch) {
    const shebangMatch = content.match(SHEBANG_REGEX);
    const shebang = shebangMatch ? shebangMatch[0] : '';
    // Remove old header (including shebang captured by regex), prepend correct one
    const stripped = content.slice(incompleteMatch[0].length);
    const newContent = (shebang ? shebang : '') + LICENSE_HEADER + stripped;

    if (!dryRun) {
      await writeFile(filePath, newContent, 'utf-8');
    }
    return 'replaced';
  }

  // No header at all — add one
  let newContent: string;
  const shebangMatch = content.match(SHEBANG_REGEX);

  if (shebangMatch) {
    newContent = shebangMatch[0] + LICENSE_HEADER + content.slice(shebangMatch[0].length);
  } else {
    newContent = LICENSE_HEADER + content;
  }

  if (!dryRun) {
    await writeFile(filePath, newContent, 'utf-8');
  }

  return 'added';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const dirs = [join(process.cwd(), 'src'), join(process.cwd(), '__tests__')];
  let added = 0;
  let replaced = 0;
  let skipped = 0;

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Adding GPL-3.0 license headers to TypeScript files...\n`);

  for (const dir of dirs) {
    for await (const filePath of walkDir(dir)) {
      const relativePath = relative(process.cwd(), filePath);

      try {
        const result = await processFile(filePath, dryRun);

        if (result === 'added') {
          console.log(`+ ${relativePath}`);
          added++;
        } else if (result === 'replaced') {
          console.log(`~ ${relativePath}`);
          replaced++;
        } else {
          skipped++;
        }
      } catch (error) {
        console.error(`✗ ${relativePath}: ${error}`);
      }
    }
  }

  console.log(`\nDone! Added: ${added}, Replaced: ${replaced}, Skipped (complete): ${skipped}`);

  if (dryRun) {
    console.log('\nThis was a dry run. Run without --dry-run to apply changes.');
  }
}

main().catch(console.error);
