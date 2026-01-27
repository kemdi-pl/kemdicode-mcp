#!/usr/bin/env bun
/**
 * Add GPL-3.0 License Headers to Source Files
 *
 * This script adds the GPL-3.0 license header to all TypeScript files
 * in the src/ directory that don't already have it.
 *
 * Usage: bun scripts/add-license-headers.ts [--dry-run]
 */

import { readdir, readFile, writeFile } from 'fs/promises';
import { join, relative } from 'path';

const LICENSE_HEADER = `/**
 * KemdiCode MCP Server
 * Copyright (C) 2024-2026 Kemdi Sp. z o.o.
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
const HAS_LICENSE_REGEX = /KemdiCode MCP Server|GNU General Public License/;

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

async function processFile(filePath: string, dryRun: boolean): Promise<boolean> {
  const content = await readFile(filePath, 'utf-8');

  // Check if already has license
  if (HAS_LICENSE_REGEX.test(content)) {
    return false;
  }

  // Handle shebang
  let newContent: string;
  const shebangMatch = content.match(SHEBANG_REGEX);

  if (shebangMatch) {
    // Keep shebang at the top
    newContent = shebangMatch[0] + LICENSE_HEADER + content.slice(shebangMatch[0].length);
  } else {
    newContent = LICENSE_HEADER + content;
  }

  if (!dryRun) {
    await writeFile(filePath, newContent, 'utf-8');
  }

  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const srcDir = join(process.cwd(), 'src');
  let processed = 0;
  let skipped = 0;

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Adding GPL-3.0 license headers to TypeScript files...\n`);

  for await (const filePath of walkDir(srcDir)) {
    const relativePath = relative(process.cwd(), filePath);

    try {
      const wasProcessed = await processFile(filePath, dryRun);

      if (wasProcessed) {
        console.log(`✓ ${relativePath}`);
        processed++;
      } else {
        skipped++;
      }
    } catch (error) {
      console.error(`✗ ${relativePath}: ${error}`);
    }
  }

  console.log(`\nDone! Processed: ${processed}, Skipped (already has license): ${skipped}`);

  if (dryRun) {
    console.log('\nThis was a dry run. Run without --dry-run to apply changes.');
  }
}

main().catch(console.error);
