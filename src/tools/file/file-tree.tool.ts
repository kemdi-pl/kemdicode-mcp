/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
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

/**
 * File Tree Tool
 *
 * Generate directory tree with depth limits, ignore patterns,
 * file type icons, and size information.
 *
 * @module tools/file/file-tree
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { UnifiedTool } from '../registry.js';
import { Logger } from '../../utils/logger.js';

/** Maximum entries to prevent memory issues */
const MAX_ENTRIES = 5000;

/** Default max depth */
const DEFAULT_MAX_DEPTH = 5;

/** File type icons (emoji-free for terminal compatibility) */
const FILE_ICONS: Record<string, string> = {
  // Directories
  directory: '[DIR]',
  // Programming languages
  '.ts': '[TS]',
  '.tsx': '[TSX]',
  '.js': '[JS]',
  '.jsx': '[JSX]',
  '.py': '[PY]',
  '.rb': '[RB]',
  '.go': '[GO]',
  '.rs': '[RS]',
  '.java': '[JAVA]',
  '.c': '[C]',
  '.cpp': '[CPP]',
  '.h': '[H]',
  '.php': '[PHP]',
  '.swift': '[SWIFT]',
  '.kt': '[KT]',
  // Web
  '.html': '[HTML]',
  '.css': '[CSS]',
  '.scss': '[SCSS]',
  '.less': '[LESS]',
  '.vue': '[VUE]',
  '.svelte': '[SVELTE]',
  // Data
  '.json': '[JSON]',
  '.yaml': '[YAML]',
  '.yml': '[YAML]',
  '.xml': '[XML]',
  '.toml': '[TOML]',
  '.csv': '[CSV]',
  // Docs
  '.md': '[MD]',
  '.txt': '[TXT]',
  '.pdf': '[PDF]',
  '.doc': '[DOC]',
  // Config
  '.env': '[ENV]',
  '.gitignore': '[GIT]',
  '.dockerignore': '[DOCKER]',
  // Images
  '.png': '[IMG]',
  '.jpg': '[IMG]',
  '.jpeg': '[IMG]',
  '.gif': '[IMG]',
  '.svg': '[SVG]',
  '.webp': '[IMG]',
  // Default
  default: '[FILE]',
};

/** Default ignore patterns (similar to .gitignore) */
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.vscode',
  '.idea',
  '*.log',
  '*.lock',
  '.DS_Store',
  'Thumbs.db',
  'vendor',
  '.bundle',
];

const schema = z.object({
  path: z.string().default('.').describe('Directory path to list'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(DEFAULT_MAX_DEPTH)
    .describe('Maximum depth to traverse'),
  showHidden: z.boolean().default(false).describe('Include hidden files (starting with .)'),
  showSize: z.boolean().default(false).describe('Include file sizes'),
  showIcons: z.boolean().default(true).describe('Show file type icons'),
  ignorePatterns: z.array(z.string()).optional().describe('Patterns to ignore (glob-style)'),
  includePatterns: z
    .array(z.string())
    .optional()
    .describe('Only include files matching these patterns'),
  gitignore: z.boolean().default(true).describe('Respect .gitignore rules'),
  dirsOnly: z.boolean().default(false).describe('Show only directories'),
  filesOnly: z.boolean().default(false).describe('Show only files'),
  sortBy: z.enum(['name', 'size', 'modified', 'type']).default('name').describe('Sort entries by'),
  maxEntries: z
    .number()
    .int()
    .positive()
    .default(MAX_ENTRIES)
    .describe('Maximum entries to return'),
});

type FileTreeArgs = z.infer<typeof schema>;

interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  icon?: string;
  children?: TreeEntry[];
  modified?: string;
}

interface TreeResult {
  success: boolean;
  root: string;
  tree?: TreeEntry;
  totalFiles?: number;
  totalDirs?: number;
  totalSize?: number;
  truncated?: boolean;
  error?: string;
}

/**
 * Get file icon based on extension
 */
function getFileIcon(name: string, isDirectory: boolean): string {
  if (isDirectory) {
    return FILE_ICONS.directory;
  }

  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return FILE_ICONS[ext] || FILE_ICONS.default;
}

/**
 * Format file size for display
 */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Check if a name matches any of the ignore patterns
 */
function matchesPattern(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Simple glob matching
    if (pattern.startsWith('*')) {
      if (name.endsWith(pattern.slice(1))) return true;
    } else if (pattern.endsWith('*')) {
      if (name.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern.includes('*')) {
      const [prefix, suffix] = pattern.split('*');
      if (name.startsWith(prefix) && name.endsWith(suffix)) return true;
    } else {
      if (name === pattern) return true;
    }
  }
  return false;
}

/**
 * Parse .gitignore file and return patterns
 */
async function parseGitignore(dirPath: string): Promise<string[]> {
  try {
    const gitignorePath = join(dirPath, '.gitignore');
    const content = await fs.readFile(gitignorePath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Recursively build directory tree
 */
async function buildTree(
  dirPath: string,
  args: FileTreeArgs,
  ignorePatterns: string[],
  depth: number,
  stats: { files: number; dirs: number; size: number; entries: number }
): Promise<TreeEntry | null> {
  if (depth > args.maxDepth || stats.entries >= args.maxEntries) {
    return null;
  }

  const name = basename(dirPath) || dirPath;

  try {
    const dirStats = await fs.stat(dirPath);

    if (dirStats.isFile()) {
      if (args.dirsOnly) return null;

      stats.files++;
      stats.size += dirStats.size;
      stats.entries++;

      const entry: TreeEntry = {
        name,
        path: dirPath,
        type: 'file',
        modified: dirStats.mtime.toISOString(),
      };

      if (args.showSize) {
        entry.size = dirStats.size;
      }

      if (args.showIcons) {
        entry.icon = getFileIcon(name, false);
      }

      return entry;
    }

    if (!dirStats.isDirectory()) {
      return null;
    }

    // It's a directory
    stats.dirs++;
    stats.entries++;

    const entry: TreeEntry = {
      name,
      path: dirPath,
      type: 'directory',
      children: [],
      modified: dirStats.mtime.toISOString(),
    };

    if (args.showIcons) {
      entry.icon = getFileIcon(name, true);
    }

    // Read directory contents
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    // Load gitignore patterns for this directory
    let localIgnore = ignorePatterns;
    if (args.gitignore) {
      const gitignorePatterns = await parseGitignore(dirPath);
      localIgnore = [...ignorePatterns, ...gitignorePatterns];
    }

    // Sort entries
    const sortedEntries = entries.sort((a, b) => {
      // Directories first
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;

      switch (args.sortBy) {
        case 'name':
        default:
          return a.name.localeCompare(b.name);
      }
    });

    for (const dirent of sortedEntries) {
      if (stats.entries >= args.maxEntries) break;

      const childName = dirent.name;
      const childPath = join(dirPath, childName);

      // Skip hidden files if not requested
      if (!args.showHidden && childName.startsWith('.')) {
        continue;
      }

      // Skip ignored patterns
      if (matchesPattern(childName, localIgnore)) {
        continue;
      }

      // Check include patterns
      if (args.includePatterns && args.includePatterns.length > 0) {
        if (!matchesPattern(childName, args.includePatterns)) {
          continue;
        }
      }

      // Skip files if dirsOnly
      if (args.dirsOnly && !dirent.isDirectory()) {
        continue;
      }

      // Skip directories if filesOnly
      if (args.filesOnly && dirent.isDirectory()) {
        continue;
      }

      const child = await buildTree(childPath, args, localIgnore, depth + 1, stats);

      if (child) {
        entry.children!.push(child);
      }
    }

    return entry;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EACCES') {
      return null; // Skip inaccessible directories
    }
    throw error;
  }
}

/**
 * Format tree as string for display
 */
function formatTreeString(entry: TreeEntry, prefix = '', isLast = true): string {
  const lines: string[] = [];
  const connector = isLast ? '\\-- ' : '|-- ';
  const icon = entry.icon ? `${entry.icon} ` : '';
  const size = entry.size !== undefined ? ` (${formatSize(entry.size)})` : '';

  lines.push(`${prefix}${connector}${icon}${entry.name}${size}`);

  if (entry.children && entry.children.length > 0) {
    const childPrefix = prefix + (isLast ? '    ' : '|   ');
    entry.children.forEach((child, index) => {
      const isLastChild = index === entry.children!.length - 1;
      lines.push(formatTreeString(child, childPrefix, isLastChild));
    });
  }

  return lines.join('\n');
}

export const fileTreeTool: UnifiedTool<typeof schema> = {
  name: 'file-tree',
  description:
    'Generate directory tree with depth limits, ignore patterns, file icons, and size info',
  zodSchema: schema,
  skipContextShare: true, // Tree output may be large

  execute: async (args): Promise<string> => {
    // args is now properly typed as FileTreeArgs via the generic
    const treeArgs = args;
    const result: TreeResult = {
      success: false,
      root: treeArgs.path,
    };

    try {
      // Build ignore patterns
      const ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...(treeArgs.ignorePatterns || [])];

      const stats = { files: 0, dirs: 0, size: 0, entries: 0 };

      const tree = await buildTree(treeArgs.path, treeArgs, ignorePatterns, 0, stats);

      if (!tree) {
        result.error = `Cannot access path: ${treeArgs.path}`;
        return JSON.stringify(result);
      }

      result.success = true;
      result.tree = tree;
      result.totalFiles = stats.files;
      result.totalDirs = stats.dirs;
      result.totalSize = stats.size;
      result.truncated = stats.entries >= treeArgs.maxEntries;

      // Also include a formatted string representation
      const formattedTree = formatTreeString(tree, '', true);

      return JSON.stringify({
        ...result,
        formatted: formattedTree,
        summary: `${stats.dirs} directories, ${stats.files} files${stats.size > 0 ? `, ${formatSize(stats.size)}` : ''}`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`file-tree error: ${errorMessage}`);

      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        result.error = `Directory not found: ${treeArgs.path}`;
      } else if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        result.error = `Permission denied: ${treeArgs.path}`;
      } else {
        result.error = errorMessage;
      }

      return JSON.stringify(result);
    }
  },
};
