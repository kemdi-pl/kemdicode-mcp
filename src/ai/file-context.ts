/**
 * KemdiCode MCP Server - File Context
 * Load and format file contents for AI context
 *
 * @license GPL-3.0
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, basename, relative } from 'node:path';
import { existsSync } from 'node:fs';

export interface FileContext {
  path: string;
  relativePath: string;
  content: string;
  language: string;
  size: number;
  truncated: boolean;
}

/**
 * Language detection by file extension
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // JavaScript/TypeScript
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',

  // Web
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',

  // Backend
  '.php': 'php',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.cs': 'csharp',
  '.fs': 'fsharp',
  '.swift': 'swift',

  // Data/Config
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.ini': 'ini',
  '.env': 'shell',

  // Shell/Scripts
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'zsh',
  '.fish': 'fish',
  '.ps1': 'powershell',
  '.bat': 'batch',
  '.cmd': 'batch',

  // Database
  '.sql': 'sql',
  '.prisma': 'prisma',

  // Docs
  '.md': 'markdown',
  '.mdx': 'mdx',
  '.rst': 'rst',
  '.txt': 'text',

  // Other
  '.dockerfile': 'dockerfile',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.lua': 'lua',
  '.r': 'r',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.clj': 'clojure',
  '.lisp': 'lisp',
  '.ml': 'ocaml',
  '.nim': 'nim',
  '.zig': 'zig',
  '.v': 'v',
  '.dart': 'dart',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
};

/**
 * Max file size to load (5MB)
 */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Max content length to include (100k chars)
 */
const MAX_CONTENT_LENGTH = 100000;

/**
 * Detect language from file path
 */
export function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();

  // Check extension map
  if (EXTENSION_TO_LANGUAGE[ext]) {
    return EXTENSION_TO_LANGUAGE[ext];
  }

  // Check filename for special cases
  const filename = basename(filePath).toLowerCase();
  if (filename === 'dockerfile' || filename.startsWith('dockerfile.')) {
    return 'dockerfile';
  }
  if (filename === 'makefile' || filename === 'gnumakefile') {
    return 'makefile';
  }
  if (filename === '.gitignore' || filename === '.dockerignore') {
    return 'gitignore';
  }
  if (filename.endsWith('.config.js') || filename.endsWith('.config.ts')) {
    return ext === '.ts' ? 'typescript' : 'javascript';
  }

  return 'text';
}

/**
 * Parse file path string (handles @path/file syntax)
 */
export function parseFilePath(input: string): string {
  // Remove @ prefix if present (KemdiCode convention)
  let path = input.trim();
  if (path.startsWith('@')) {
    path = path.slice(1);
  }
  return path;
}

/**
 * Parse multiple file paths from input
 * Supports: "@file1 @file2", "file1,file2", "file1 file2"
 */
export function parseFiles(input: string | undefined | null): string[] {
  if (!input) return [];

  const files: string[] = [];
  const normalized = input.trim();

  // Split by common delimiters
  const parts = normalized.split(/[\s,;]+/);

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) {
      files.push(parseFilePath(trimmed));
    }
  }

  return files;
}

/**
 * Load a single file's content
 */
export async function loadFileContext(
  filePath: string,
  projectRoot?: string
): Promise<FileContext | null> {
  try {
    // Resolve absolute path
    const absolutePath = projectRoot ? resolve(projectRoot, filePath) : resolve(filePath);

    if (!existsSync(absolutePath)) {
      console.warn(`File not found: ${absolutePath}`);
      return null;
    }

    // Check file size
    const stats = await stat(absolutePath);
    if (stats.size > MAX_FILE_SIZE) {
      console.warn(`File too large (${stats.size} bytes): ${absolutePath}`);
      return null;
    }

    // Read file
    let content = await readFile(absolutePath, 'utf-8');
    let truncated = false;

    // Truncate if too long
    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.slice(0, MAX_CONTENT_LENGTH) + '\n\n... [truncated]';
      truncated = true;
    }

    return {
      path: absolutePath,
      relativePath: projectRoot ? relative(projectRoot, absolutePath) : filePath,
      content,
      language: detectLanguage(absolutePath),
      size: stats.size,
      truncated,
    };
  } catch (error) {
    console.warn(`Error loading file ${filePath}:`, error);
    return null;
  }
}

/**
 * Load multiple files
 */
export async function loadFileContexts(
  filePaths: string[],
  projectRoot?: string
): Promise<FileContext[]> {
  const results = await Promise.all(filePaths.map((path) => loadFileContext(path, projectRoot)));

  return results.filter((ctx): ctx is FileContext => ctx !== null);
}

/**
 * Format file contexts for prompt injection
 */
export function formatFileContextForPrompt(files: FileContext[]): string {
  if (files.length === 0) return '';

  const sections: string[] = [];

  for (const file of files) {
    const header = `## File: ${file.relativePath}`;
    const warning = file.truncated ? '\n> Note: File truncated due to size' : '';
    const codeBlock = `\`\`\`${file.language}\n${file.content}\n\`\`\``;

    sections.push(`${header}${warning}\n${codeBlock}`);
  }

  return `# Referenced Files\n\n${sections.join('\n\n')}`;
}

/**
 * Convenience function: load and format files in one call
 */
export async function loadAndFormatFiles(
  filePaths: string[],
  projectRoot?: string
): Promise<string> {
  const contexts = await loadFileContexts(filePaths, projectRoot);
  return formatFileContextForPrompt(contexts);
}
