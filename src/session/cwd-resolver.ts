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
 * CWD Resolver Module
 *
 * Resolves the working directory for a session using multiple strategies
 * with a priority-based fallback system. Also provides comprehensive project
 * type detection from configuration files.
 *
 * Performance optimizations:
 * - Caches git root detection results (git rev-parse is slow)
 * - Caches project type detection results
 * - Uses parallel file existence checks where possible
 *
 * @module session/cwd-resolver
 */

import { spawn } from 'child_process';
import { access, readFile } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { Logger } from '../utils/logger.js';
import { gitCache, fsCache, projectCache } from '../utils/cache.js';
import { CwdResolutionResult, CwdSource, ProjectType, ProjectInfo } from './types.js';

/**
 * Options for CWD resolution
 *
 * @interface CwdResolutionOptions
 * @description Configuration options passed to resolveCwd function
 */
export interface CwdResolutionOptions {
  /** X-Project-Path header value from HTTP request */
  headerPath?: string;
  /** cwd parameter from tool request body */
  parameterCwd?: string;
  /** Explicitly set CWD (used when creating sessions) */
  explicitCwd?: string;
}

/**
 * Project detection patterns
 *
 * @description Maps project types to their marker files and detection priority.
 *              Lower priority number = checked first.
 * @constant
 */
const PROJECT_PATTERNS: Record<ProjectType, { files: string[]; priority: number }> = {
  node: {
    files: ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
    priority: 1,
  },
  php: {
    files: ['composer.json', 'composer.lock', 'artisan', 'index.php'],
    priority: 2,
  },
  python: {
    files: ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile', 'poetry.lock'],
    priority: 3,
  },
  rust: {
    files: ['Cargo.toml', 'Cargo.lock'],
    priority: 4,
  },
  go: {
    files: ['go.mod', 'go.sum'],
    priority: 5,
  },
  ruby: {
    files: ['Gemfile', 'Gemfile.lock', '.ruby-version'],
    priority: 6,
  },
  java: {
    files: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
    priority: 7,
  },
  dotnet: {
    files: ['*.csproj', '*.fsproj', '*.sln', 'global.json'],
    priority: 8,
  },
  unknown: {
    files: [],
    priority: 99,
  },
};

/**
 * Framework detection patterns
 *
 * @description Maps framework names to their project type and marker files.
 *              Used for more specific framework detection within a project type.
 * @constant
 * @private
 */
const _FRAMEWORK_PATTERNS: Record<string, { type: ProjectType; markers: string[] }> = {
  laravel: { type: 'php', markers: ['artisan', 'bootstrap/app.php'] },
  symfony: { type: 'php', markers: ['symfony.lock', 'config/bundles.php'] },
  nextjs: { type: 'node', markers: ['next.config.js', 'next.config.mjs', 'next.config.ts'] },
  nuxt: { type: 'node', markers: ['nuxt.config.js', 'nuxt.config.ts'] },
  vite: { type: 'node', markers: ['vite.config.js', 'vite.config.ts'] },
  express: { type: 'node', markers: ['express'] }, // Check in package.json
  django: { type: 'python', markers: ['manage.py', 'django'] },
  flask: { type: 'python', markers: ['flask'] },
  rails: { type: 'ruby', markers: ['config/routes.rb', 'Gemfile'] },
  spring: { type: 'java', markers: ['spring'] },
};

/**
 * Execute a shell command and return stdout
 *
 * @description Spawns a process and captures stdout. Has a 5 second timeout.
 * @param {string} command - Command to execute
 * @param {string[]} args - Command arguments
 * @param {string} [cwd] - Working directory for command
 * @returns {Promise<string>} Trimmed stdout output
 * @throws {Error} If command exits with non-zero code or times out
 * @private
 */
async function execCommand(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      shell: false,
      timeout: 5000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `Command failed with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Check if a file exists (cached)
 *
 * @description Checks file existence with result caching to avoid repeated fs calls.
 *              Cache key format: 'exists:{path}'
 * @param {string} path - Absolute path to check
 * @returns {Promise<boolean>} True if file/directory exists
 * @private
 */
async function fileExists(path: string): Promise<boolean> {
  // Check cache first
  const cacheKey = `exists:${path}`;
  const cached = fsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached as boolean;
  }

  try {
    await access(path);
    fsCache.set(cacheKey, true);
    return true;
  } catch {
    fsCache.set(cacheKey, false);
    return false;
  }
}

/**
 * Check multiple files exist in parallel
 *
 * @description Checks all paths concurrently and returns the first one that exists.
 *              Useful for finding project marker files efficiently.
 * @param {string[]} paths - Array of absolute paths to check
 * @returns {Promise<string | null>} First existing path or null if none found
 * @private
 */
async function _findFirstExisting(paths: string[]): Promise<string | null> {
  const results = await Promise.all(
    paths.map(async (p) => ({ path: p, exists: await fileExists(p) }))
  );
  const found = results.find((r) => r.exists);
  return found ? found.path : null;
}

/**
 * Get git root directory (cached)
 *
 * @description Finds the root of the git repository containing startDir.
 *              Results are cached as git rev-parse is an expensive operation.
 * @param {string} startDir - Directory to start search from
 * @returns {Promise<string | null>} Git repository root path or null if not in a repo
 * @private
 */
async function getGitRoot(startDir: string): Promise<string | null> {
  const cacheKey = `gitroot:${startDir}`;
  const cached = gitCache.get(cacheKey);
  if (cached !== undefined) {
    return cached as string | null;
  }

  try {
    const gitRoot = await execCommand('git', ['rev-parse', '--show-toplevel'], startDir);
    const result = gitRoot || null;
    gitCache.set(cacheKey, result);
    return result;
  } catch {
    gitCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Check if directory is a git repository
 *
 * @description Checks if directory contains a .git folder (is a git root)
 * @param {string} dir - Directory to check
 * @returns {Promise<boolean>} True if directory is a git repository root
 * @private
 */
async function isGitRepo(dir: string): Promise<boolean> {
  const gitDir = join(dir, '.git');
  return fileExists(gitDir);
}

/**
 * Detect project type from directory (cached)
 *
 * @description Identifies the project type by checking for marker files (package.json,
 *              Cargo.toml, etc). Uses parallel checks and caching for performance.
 * @param {string} dir - Directory to analyze
 * @returns {Promise<ProjectType>} Detected project type ('node', 'php', 'rust', etc.) or 'unknown'
 * @example
 * ```typescript
 * const type = await detectProjectType('/path/to/project');
 * // Returns: 'node', 'php', 'python', 'rust', 'go', 'ruby', 'java', 'dotnet', or 'unknown'
 * ```
 */
export async function detectProjectType(dir: string): Promise<ProjectType> {
  const cacheKey = `projtype:${dir}`;
  const cached = projectCache.get(cacheKey);
  if (cached !== undefined) {
    return cached as ProjectType;
  }

  // Build list of all files to check across all project types
  const allChecks: { type: ProjectType; file: string; path: string }[] = [];

  for (const [type, config] of Object.entries(PROJECT_PATTERNS)) {
    if (type === 'unknown') continue;

    for (const file of config.files) {
      if (!file.includes('*')) {
        allChecks.push({
          type: type as ProjectType,
          file,
          path: join(dir, file),
        });
      }
    }
  }

  // Check all files in parallel
  const results = await Promise.all(
    allChecks.map(async (check) => ({
      ...check,
      exists: await fileExists(check.path),
    }))
  );

  // Find first existing file by priority order
  const sortedTypes = Object.entries(PROJECT_PATTERNS)
    .filter(([t]) => t !== 'unknown')
    .sort((a, b) => a[1].priority - b[1].priority)
    .map(([t]) => t as ProjectType);

  for (const type of sortedTypes) {
    const found = results.find((r) => r.type === type && r.exists);
    if (found) {
      projectCache.set(cacheKey, type);
      return type;
    }
  }

  // Handle glob patterns for dotnet (less common, check last)
  try {
    const { readdirSync } = await import('fs');
    const files = readdirSync(dir);
    const dotnetExts = ['.csproj', '.fsproj', '.sln'];
    if (files.some((f) => dotnetExts.some((ext) => f.endsWith(ext)))) {
      projectCache.set(cacheKey, 'dotnet');
      return 'dotnet';
    }
  } catch {
    // Directory might not exist
  }

  projectCache.set(cacheKey, 'unknown');
  return 'unknown';
}

/**
 * Detect detailed project information
 *
 * @description Performs comprehensive project analysis including type, name, version,
 *              framework, package manager, and monorepo detection. Reads config files
 *              (package.json, Cargo.toml, etc.) to extract metadata.
 * @param {string} dir - Directory to analyze
 * @returns {Promise<ProjectInfo>} Detailed project information object
 * @example
 * ```typescript
 * const info = await detectProjectInfo('/path/to/project');
 * // Returns: { type: 'node', name: 'my-app', version: '1.0.0',
 * //            framework: 'nextjs', packageManager: 'pnpm', isMonorepo: false }
 * ```
 */
export async function detectProjectInfo(dir: string): Promise<ProjectInfo> {
  const type = await detectProjectType(dir);
  const info: ProjectInfo = { type };

  try {
    switch (type) {
      case 'node': {
        const packageJsonPath = join(dir, 'package.json');
        if (await fileExists(packageJsonPath)) {
          const content = await readFile(packageJsonPath, 'utf-8');
          const pkg = JSON.parse(content);
          info.name = pkg.name;
          info.version = pkg.version;
          info.configFile = 'package.json';

          // Detect package manager and monorepo in parallel
          const [hasPnpm, hasYarn, hasNpm, hasLerna] = await Promise.all([
            fileExists(join(dir, 'pnpm-lock.yaml')),
            fileExists(join(dir, 'yarn.lock')),
            fileExists(join(dir, 'package-lock.json')),
            fileExists(join(dir, 'lerna.json')),
          ]);

          if (hasPnpm) info.packageManager = 'pnpm';
          else if (hasYarn) info.packageManager = 'yarn';
          else if (hasNpm) info.packageManager = 'npm';

          // Detect monorepo
          if (pkg.workspaces || hasLerna) {
            info.isMonorepo = true;
          }

          // Detect framework from dependencies
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps['next']) info.framework = 'nextjs';
          else if (deps['nuxt']) info.framework = 'nuxt';
          else if (deps['vite']) info.framework = 'vite';
          else if (deps['express']) info.framework = 'express';
          else if (deps['@angular/core']) info.framework = 'angular';
          else if (deps['react'] && !deps['next']) info.framework = 'react';
          else if (deps['vue'] && !deps['nuxt']) info.framework = 'vue';
        }
        break;
      }

      case 'php': {
        const composerPath = join(dir, 'composer.json');
        if (await fileExists(composerPath)) {
          const content = await readFile(composerPath, 'utf-8');
          const composer = JSON.parse(content);
          info.name = composer.name;
          info.version = composer.version;
          info.configFile = 'composer.json';
          info.packageManager = 'composer';

          // Detect framework in parallel
          const [hasArtisan, hasSymfonyLock] = await Promise.all([
            fileExists(join(dir, 'artisan')),
            fileExists(join(dir, 'symfony.lock')),
          ]);

          if (hasArtisan) info.framework = 'laravel';
          else if (hasSymfonyLock) info.framework = 'symfony';
        }
        break;
      }

      case 'python': {
        const pyprojectPath = join(dir, 'pyproject.toml');
        const setupPyPath = join(dir, 'setup.py');

        if (await fileExists(pyprojectPath)) {
          info.configFile = 'pyproject.toml';
          // Basic TOML parsing for name
          const content = await readFile(pyprojectPath, 'utf-8');
          const nameMatch = content.match(/name\s*=\s*["']([^"']+)["']/);
          if (nameMatch) info.name = nameMatch[1];

          if (content.includes('[tool.poetry]')) {
            info.packageManager = 'poetry';
          } else if (await fileExists(join(dir, 'Pipfile'))) {
            info.packageManager = 'pipenv';
          } else {
            info.packageManager = 'pip';
          }
        } else if (await fileExists(setupPyPath)) {
          info.configFile = 'setup.py';
          info.packageManager = 'pip';
        }

        // Detect Django/Flask
        if (await fileExists(join(dir, 'manage.py'))) {
          info.framework = 'django';
        }
        break;
      }

      case 'rust': {
        const cargoPath = join(dir, 'Cargo.toml');
        if (await fileExists(cargoPath)) {
          const content = await readFile(cargoPath, 'utf-8');
          const nameMatch = content.match(/name\s*=\s*["']([^"']+)["']/);
          const versionMatch = content.match(/version\s*=\s*["']([^"']+)["']/);
          if (nameMatch) info.name = nameMatch[1];
          if (versionMatch) info.version = versionMatch[1];
          info.configFile = 'Cargo.toml';
          info.packageManager = 'cargo';

          // Check for workspace
          if (content.includes('[workspace]')) {
            info.isMonorepo = true;
          }
        }
        break;
      }

      case 'go': {
        const goModPath = join(dir, 'go.mod');
        if (await fileExists(goModPath)) {
          const content = await readFile(goModPath, 'utf-8');
          const moduleMatch = content.match(/module\s+(\S+)/);
          if (moduleMatch) info.name = moduleMatch[1];
          info.configFile = 'go.mod';
          info.packageManager = 'go';
        }
        break;
      }

      case 'ruby': {
        const gemfilePath = join(dir, 'Gemfile');
        if (await fileExists(gemfilePath)) {
          info.configFile = 'Gemfile';
          info.packageManager = 'bundler';

          // Check for Rails
          const content = await readFile(gemfilePath, 'utf-8');
          if (content.includes("gem 'rails'") || content.includes('gem "rails"')) {
            info.framework = 'rails';
          }
        }
        break;
      }

      case 'java': {
        // Check all Java build files in parallel
        const [hasPom, hasGradle, hasGradleKts] = await Promise.all([
          fileExists(join(dir, 'pom.xml')),
          fileExists(join(dir, 'build.gradle')),
          fileExists(join(dir, 'build.gradle.kts')),
        ]);

        if (hasPom) {
          info.configFile = 'pom.xml';
          info.packageManager = 'maven';
        } else if (hasGradle || hasGradleKts) {
          info.configFile = 'build.gradle';
          info.packageManager = 'gradle';
        }
        break;
      }

      case 'dotnet': {
        // Find first .csproj or .sln file
        try {
          const { readdirSync } = await import('fs');
          const files = readdirSync(dir);
          const projectFile = files.find((f) => f.endsWith('.csproj') || f.endsWith('.sln'));
          if (projectFile) {
            info.configFile = projectFile;
            info.name = basename(projectFile).replace(/\.(csproj|sln)$/, '');
          }
          info.packageManager = 'dotnet';
        } catch {
          // Ignore
        }
        break;
      }
    }
  } catch (error) {
    Logger.debug(`Failed to detect project info: ${error}`);
  }

  return info;
}

/**
 * Resolve CWD using priority order
 *
 * @description Determines the working directory using a priority-based fallback system.
 *              Also detects project type and git information for the resolved directory.
 *
 * Priority order:
 * 1. X-Project-Path header (from HTTP request)
 * 2. cwd parameter in request body
 * 3. explicitCwd option (programmatic override)
 * 4. KEMDICODE_PROJECT_PATH environment variable
 * 5. Auto-detect git root from process.cwd()
 * 6. process.cwd() fallback
 *
 * @param {CwdResolutionOptions} [options] - Resolution options
 * @returns {Promise<CwdResolutionResult>} Resolution result with cwd, source, and project info
 * @example
 * ```typescript
 * const result = await resolveCwd({ headerPath: '/path/from/header' });
 * // Returns: { cwd: '/path/from/header', source: 'header',
 * //            isGitRepo: true, projectType: 'node', projectName: 'my-app' }
 * ```
 */
export async function resolveCwd(options: CwdResolutionOptions = {}): Promise<CwdResolutionResult> {
  let cwd: string;
  let source: CwdSource;

  // 1. Check X-Project-Path header
  if (options.headerPath && (await validateDirectory(options.headerPath))) {
    cwd = options.headerPath;
    source = 'header';
  }
  // 2. Check cwd parameter
  else if (options.parameterCwd && (await validateDirectory(options.parameterCwd))) {
    cwd = options.parameterCwd;
    source = 'parameter';
  }
  // 3. Check explicit CWD
  else if (options.explicitCwd && (await validateDirectory(options.explicitCwd))) {
    cwd = options.explicitCwd;
    source = 'explicit';
  }
  // 4. Check KEMDICODE_PROJECT_PATH env
  else if (
    process.env.KEMDICODE_PROJECT_PATH &&
    (await validateDirectory(process.env.KEMDICODE_PROJECT_PATH))
  ) {
    cwd = process.env.KEMDICODE_PROJECT_PATH;
    source = 'env';
  }
  // 5. Try to detect git root
  else {
    const gitRoot = await getGitRoot(process.cwd());
    if (gitRoot && (await validateDirectory(gitRoot))) {
      cwd = gitRoot;
      source = 'git-root';
    } else {
      // 6. Fallback to process.cwd()
      cwd = process.cwd();
      source = 'process-cwd';
    }
  }

  // Detect project info
  const projectInfo = await detectProjectInfo(cwd);
  const isRepo = await isGitRepo(cwd);
  const gitRoot = isRepo ? await getGitRoot(cwd) : undefined;

  return {
    cwd,
    source,
    isGitRepo: isRepo,
    gitRoot: gitRoot || undefined,
    projectType: projectInfo.type,
    projectName: projectInfo.name,
  };
}

/**
 * Validate that a path is a valid directory
 *
 * @description Checks if path exists and is a directory (not a file)
 * @param {string} path - Path to validate
 * @returns {Promise<boolean>} True if path is a valid directory
 * @private
 */
async function validateDirectory(path: string): Promise<boolean> {
  try {
    const { stat } = await import('fs/promises');
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find project root by walking up the directory tree
 *
 * @description Walks up the directory tree from startDir looking for project markers
 *              or git repository root. Stops at filesystem root if nothing found.
 * @param {string} startDir - Directory to start searching from
 * @returns {Promise<string | null>} Project root path or null if not found
 * @example
 * ```typescript
 * const root = await findProjectRoot('/path/to/project/src/deep/folder');
 * // Returns: '/path/to/project' (where package.json exists)
 * ```
 */
export async function findProjectRoot(startDir: string): Promise<string | null> {
  let currentDir = startDir;
  const root = dirname(currentDir);

  while (currentDir !== root) {
    // Check for project markers
    const type = await detectProjectType(currentDir);
    if (type !== 'unknown') {
      return currentDir;
    }

    // Check for git root
    if (await isGitRepo(currentDir)) {
      return currentDir;
    }

    currentDir = dirname(currentDir);
  }

  return null;
}

/**
 * Get package manager command for a project type
 *
 * @description Maps the detected package manager to its CLI command name.
 *              Handles special cases like bundler -> bundle, maven -> mvn.
 * @param {ProjectInfo} projectInfo - Project information with packageManager field
 * @returns {string | null} Package manager command or null if unknown
 * @example
 * ```typescript
 * const cmd = getPackageManagerCommand({ type: 'node', packageManager: 'pnpm' });
 * // Returns: 'pnpm'
 *
 * const cmd2 = getPackageManagerCommand({ type: 'ruby', packageManager: 'bundler' });
 * // Returns: 'bundle'
 * ```
 */
export function getPackageManagerCommand(projectInfo: ProjectInfo): string | null {
  switch (projectInfo.packageManager) {
    case 'npm':
      return 'npm';
    case 'yarn':
      return 'yarn';
    case 'pnpm':
      return 'pnpm';
    case 'composer':
      return 'composer';
    case 'cargo':
      return 'cargo';
    case 'go':
      return 'go';
    case 'pip':
      return 'pip';
    case 'poetry':
      return 'poetry';
    case 'pipenv':
      return 'pipenv';
    case 'bundler':
      return 'bundle';
    case 'maven':
      return 'mvn';
    case 'gradle':
      return 'gradle';
    case 'dotnet':
      return 'dotnet';
    default:
      return null;
  }
}

/**
 * Get test command for a project
 *
 * @description Returns the appropriate test command based on framework first,
 *              then falls back to package manager test command. Framework-specific
 *              commands take priority (e.g., 'php artisan test' for Laravel).
 * @param {ProjectInfo} projectInfo - Project information with framework and packageManager
 * @returns {string | null} Test command string or null if unknown
 * @example
 * ```typescript
 * const cmd = getTestCommand({ type: 'php', framework: 'laravel' });
 * // Returns: 'php artisan test'
 *
 * const cmd2 = getTestCommand({ type: 'node', packageManager: 'pnpm' });
 * // Returns: 'pnpm test'
 * ```
 */
export function getTestCommand(projectInfo: ProjectInfo): string | null {
  switch (projectInfo.framework) {
    case 'laravel':
      return 'php artisan test';
    case 'symfony':
      return 'php bin/phpunit';
    case 'django':
      return 'python manage.py test';
    case 'flask':
      return 'pytest';
    case 'rails':
      return 'bundle exec rspec';
    case 'spring':
      return projectInfo.packageManager === 'maven' ? 'mvn test' : 'gradle test';
    default:
      break;
  }

  switch (projectInfo.packageManager) {
    case 'npm':
    case 'yarn':
    case 'pnpm':
      return `${projectInfo.packageManager} test`;
    case 'composer':
      return 'composer test';
    case 'cargo':
      return 'cargo test';
    case 'go':
      return 'go test ./...';
    case 'poetry':
      return 'poetry run pytest';
    case 'pip':
    case 'pipenv':
      return 'pytest';
    case 'bundler':
      return 'bundle exec rspec';
    case 'maven':
      return 'mvn test';
    case 'gradle':
      return 'gradle test';
    case 'dotnet':
      return 'dotnet test';
    default:
      return null;
  }
}
