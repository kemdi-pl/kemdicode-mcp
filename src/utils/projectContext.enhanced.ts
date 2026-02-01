/**
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

/**
 * Enhanced Project Context Module
 *
 * Provides fully dynamic project detection and context extraction.
 * Auto-detects language, framework, runtime, and project structure
 * for any type of project (TypeScript, PHP, Python, Go, Rust, etc.)
 *
 * Performance optimizations:
 * - Uses unified LRU cache with TTL
 * - Parallel file existence checks where possible
 * - Cached runtime version detection (expensive shell commands)
 *
 * @module utils/projectContext.enhanced
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger.js';
import { projectCache, LRUCache } from './cache.js';
import { config } from '../config/index.js';

/**
 * Enhanced project context with auto-detected properties
 * @interface EnhancedProjectContext
 */
export interface EnhancedProjectContext {
  projectRoot: string;
  language: string; // Auto-detected: TypeScript, JavaScript, PHP, Python, Go, Rust, etc.
  framework: string; // Auto-detected from dependencies
  runtime: string; // Node.js version, PHP version, Python version, etc.
  packageManager: string; // npm, yarn, pnpm, composer, pip, cargo, etc.
  mainTechnologies: string[];
  structure: string;
  conventions: string[];
  commonPatterns: string[];
  externalIntegrations: string[];
  testingStack: string[];
  recentlyModifiedFiles: string[];
}

// Configurable project root
function getProjectRoot(): string {
  if (process.env.KEMDICODE_PROJECT_ROOT) {
    return process.env.KEMDICODE_PROJECT_ROOT;
  }

  const cwd = process.cwd();

  // Check for any project markers
  const projectMarkers = [
    'package.json',
    'composer.json',
    'Cargo.toml',
    'go.mod',
    'pyproject.toml',
    'requirements.txt',
    'Gemfile',
    'pom.xml',
    'build.gradle',
    'CMakeLists.txt',
    'Makefile',
  ];

  for (const marker of projectMarkers) {
    if (existsSync(join(cwd, marker))) {
      return cwd;
    }
  }

  return cwd;
}

let PROJECT_ROOT = getProjectRoot();

// Local cache for project context - uses config TTL for frequently changing data
const localCache = new LRUCache<unknown>({
  maxEntries: config.get('cache').projectSize,
  defaultTTL: config.get('cache').fsTtl, // 1 minute default
});

// Runtime version cache - uses longer TTL since versions rarely change
const runtimeCache = new LRUCache<string>({
  maxEntries: 50,
  defaultTTL: config.get('cache').projectTtl * 2, // 10 minutes default
});

/**
 * Get cached value or compute and cache
 * Uses the local LRU cache with TTL
 */
function getCached<T>(key: string, generator: () => T): T {
  const fullKey = `${PROJECT_ROOT}:${key}`;
  const cached = localCache.get(fullKey);
  if (cached !== undefined) {
    return cached as T;
  }

  const data = generator();
  localCache.set(fullKey, data);
  return data;
}

function safeFind(args: string[], timeout?: number): string {
  const effectiveTimeout = timeout ?? config.get('timeouts').safeExec;
  try {
    return execFileSync('find', args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: effectiveTimeout,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function safeExec(command: string, timeout?: number): string {
  const effectiveTimeout = timeout ?? config.get('timeouts').safeExec;
  try {
    return execSync(command, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: effectiveTimeout,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function safeReadFile(path: string): string {
  try {
    const fullPath = path.startsWith('/') ? path : join(PROJECT_ROOT, path);
    if (existsSync(fullPath)) {
      return readFileSync(fullPath, 'utf-8');
    }
  } catch {
    // ignore
  }
  return '';
}

function safeReadJson(path: string): Record<string, unknown> | null {
  const content = safeReadFile(path);
  if (content) {
    try {
      return JSON.parse(content);
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Set the project root directory programmatically
 * @param {string} path - Absolute path to project root
 */
export function setProjectRoot(path: string): void {
  PROJECT_ROOT = path;
  clearProjectContextCache();
  Logger.debug(`Project root set to: ${path}`);
}

/**
 * Get the current project root directory
 * @returns {string} Absolute path to project root
 */
export function getCurrentProjectRoot(): string {
  return PROJECT_ROOT;
}

// ============================================================================
// DYNAMIC DETECTION FUNCTIONS
// ============================================================================

function detectLanguage(): string {
  return getCached('language', () => {
    // Check for TypeScript
    if (existsSync(join(PROJECT_ROOT, 'tsconfig.json'))) return 'TypeScript';

    // Check package.json for TypeScript
    const pkg = safeReadJson('package.json') as Record<string, Record<string, string>> | null;
    if (pkg) {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps?.['typescript']) return 'TypeScript';
      if (deps?.['@types/node']) return 'TypeScript';
    }

    // Check for specific language files
    const checks: [string, string][] = [
      ['composer.json', 'PHP'],
      ['Cargo.toml', 'Rust'],
      ['go.mod', 'Go'],
      ['pyproject.toml', 'Python'],
      ['requirements.txt', 'Python'],
      ['Gemfile', 'Ruby'],
      ['pom.xml', 'Java'],
      ['build.gradle', 'Java/Kotlin'],
      ['Package.swift', 'Swift'],
      ['*.csproj', 'C#'],
    ];

    for (const [file, lang] of checks) {
      if (file.includes('*')) {
        const pattern = file.replace('*', '');
        const result = safeFind([PROJECT_ROOT, '-maxdepth', '2', '-name', `*${pattern}`, '-print', '-quit']);
        if (result) return lang;
      } else if (existsSync(join(PROJECT_ROOT, file))) {
        return lang;
      }
    }

    // Check by file extensions
    const jsFiles = safeFind([PROJECT_ROOT, '-maxdepth', '3', '-name', '*.js', '-print', '-quit']);
    const jsCount = jsFiles ? '1' : '0';
    if (parseInt(jsCount) > 0) return 'JavaScript';

    return 'Unknown';
  });
}

function detectFramework(): string {
  return getCached('framework', () => {
    // Node.js / JavaScript / TypeScript projects
    const pkg = safeReadJson('package.json') as Record<string, Record<string, string>> | null;
    if (pkg) {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Frameworks in priority order
      const frameworks: [string, string][] = [
        ['next', 'Next.js'],
        ['nuxt', 'Nuxt.js'],
        ['@angular/core', 'Angular'],
        ['vue', 'Vue.js'],
        ['svelte', 'Svelte'],
        ['@remix-run/react', 'Remix'],
        ['gatsby', 'Gatsby'],
        ['astro', 'Astro'],
        ['react', 'React'],
        ['express', 'Express.js'],
        ['fastify', 'Fastify'],
        ['koa', 'Koa'],
        ['nest', 'NestJS'],
        ['@nestjs/core', 'NestJS'],
        ['hono', 'Hono'],
        ['elysia', 'Elysia'],
        ['electron', 'Electron'],
      ];

      for (const [dep, name] of frameworks) {
        if (deps?.[dep]) return name;
      }
    }

    // PHP projects
    const composer = safeReadJson('composer.json') as Record<string, Record<string, string>> | null;
    if (composer) {
      const req = { ...composer.require, ...composer['require-dev'] };

      const phpFrameworks: [string, string][] = [
        ['laravel/framework', 'Laravel'],
        ['symfony/framework-bundle', 'Symfony'],
        ['slim/slim', 'Slim'],
        ['cakephp/cakephp', 'CakePHP'],
        ['codeigniter4/framework', 'CodeIgniter'],
        ['yiisoft/yii2', 'Yii'],
        ['drupal/core', 'Drupal'],
        ['wordpress', 'WordPress'],
      ];

      for (const [dep, name] of phpFrameworks) {
        if (req?.[dep]) return name;
      }
    }

    // Python projects
    const pyproject = safeReadFile('pyproject.toml');
    const requirements = safeReadFile('requirements.txt');
    const pyDeps = pyproject + requirements;

    if (pyDeps) {
      const pyFrameworks: [string, string][] = [
        ['django', 'Django'],
        ['flask', 'Flask'],
        ['fastapi', 'FastAPI'],
        ['tornado', 'Tornado'],
        ['pyramid', 'Pyramid'],
        ['aiohttp', 'aiohttp'],
        ['starlette', 'Starlette'],
      ];

      for (const [dep, name] of pyFrameworks) {
        if (pyDeps.toLowerCase().includes(dep)) return name;
      }
    }

    // Go projects
    const goMod = safeReadFile('go.mod');
    if (goMod) {
      const goFrameworks: [string, string][] = [
        ['gin-gonic/gin', 'Gin'],
        ['labstack/echo', 'Echo'],
        ['gofiber/fiber', 'Fiber'],
        ['gorilla/mux', 'Gorilla Mux'],
        ['go-chi/chi', 'Chi'],
      ];

      for (const [dep, name] of goFrameworks) {
        if (goMod.includes(dep)) return name;
      }
    }

    // Rust projects
    const cargoToml = safeReadFile('Cargo.toml');
    if (cargoToml) {
      const rustFrameworks: [string, string][] = [
        ['actix-web', 'Actix Web'],
        ['axum', 'Axum'],
        ['rocket', 'Rocket'],
        ['warp', 'Warp'],
        ['tide', 'Tide'],
      ];

      for (const [dep, name] of rustFrameworks) {
        if (cargoToml.includes(dep)) return name;
      }
    }

    return 'None detected';
  });
}

/**
 * Get cached runtime version (expensive shell command)
 */
function getCachedRuntimeVersion(key: string, command: string): string {
  const cached = runtimeCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const version = safeExec(command);
  runtimeCache.set(key, version);
  return version;
}

function detectRuntime(): string {
  return getCached('runtime', () => {
    const language = detectLanguage();

    switch (language) {
      case 'TypeScript':
      case 'JavaScript': {
        // Cache runtime version detection since shell commands are expensive
        const nodeVersion = getCachedRuntimeVersion('node', 'node -v');
        const bunVersion = getCachedRuntimeVersion('bun', 'bun -v');
        const denoVersion = getCachedRuntimeVersion('deno', 'deno -V');

        if (existsSync(join(PROJECT_ROOT, 'bun.lockb'))) return `Bun ${bunVersion || 'unknown'}`;
        if (existsSync(join(PROJECT_ROOT, 'deno.json'))) return `Deno ${denoVersion || 'unknown'}`;
        return `Node.js ${nodeVersion || 'unknown'}`;
      }
      case 'PHP':
        return `PHP ${getCachedRuntimeVersion('php', 'php -r "echo PHP_VERSION;"') || 'unknown'}`;
      case 'Python':
        return `Python ${getCachedRuntimeVersion('python', 'python3 --version 2>/dev/null | cut -d" " -f2') || 'unknown'}`;
      case 'Go':
        return `Go ${getCachedRuntimeVersion('go', 'go version 2>/dev/null | cut -d" " -f3') || 'unknown'}`;
      case 'Rust':
        return `Rust ${getCachedRuntimeVersion('rust', 'rustc --version 2>/dev/null | cut -d" " -f2') || 'unknown'}`;
      case 'Ruby':
        return `Ruby ${getCachedRuntimeVersion('ruby', 'ruby --version 2>/dev/null | cut -d" " -f2') || 'unknown'}`;
      case 'Java':
      case 'Java/Kotlin':
        return `Java ${getCachedRuntimeVersion('java', 'java --version 2>/dev/null | head -1') || 'unknown'}`;
      default:
        return 'Unknown';
    }
  });
}

function detectPackageManager(): string {
  return getCached('packageManager', () => {
    // Lock files indicate package manager
    const lockFiles: [string, string][] = [
      ['bun.lockb', 'bun'],
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
      ['composer.lock', 'composer'],
      ['Cargo.lock', 'cargo'],
      ['go.sum', 'go modules'],
      ['Pipfile.lock', 'pipenv'],
      ['poetry.lock', 'poetry'],
      ['uv.lock', 'uv'],
      ['Gemfile.lock', 'bundler'],
    ];

    for (const [file, manager] of lockFiles) {
      if (existsSync(join(PROJECT_ROOT, file))) return manager;
    }

    // Fallback to manifest files
    if (existsSync(join(PROJECT_ROOT, 'package.json'))) return 'npm';
    if (existsSync(join(PROJECT_ROOT, 'composer.json'))) return 'composer';
    if (existsSync(join(PROJECT_ROOT, 'requirements.txt'))) return 'pip';
    if (existsSync(join(PROJECT_ROOT, 'pyproject.toml'))) return 'pip/poetry';

    return 'Unknown';
  });
}

function detectTechnologies(): string[] {
  return getCached('technologies', () => {
    const techs: string[] = [];
    const language = detectLanguage();
    const framework = detectFramework();

    if (language !== 'Unknown') techs.push(language);
    if (framework !== 'None detected') techs.push(framework);

    // Node.js dependencies
    const pkg = safeReadJson('package.json') as Record<string, Record<string, string>> | null;
    if (pkg) {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      const techMap: [string, string][] = [
        ['tailwindcss', 'Tailwind CSS'],
        ['@radix-ui/react-dialog', 'Radix UI'],
        ['@headlessui/react', 'Headless UI'],
        ['@chakra-ui/react', 'Chakra UI'],
        ['@mui/material', 'Material UI'],
        ['recharts', 'Recharts'],
        ['d3', 'D3.js'],
        ['three', 'Three.js'],
        ['zod', 'Zod'],
        ['yup', 'Yup'],
        ['joi', 'Joi'],
        ['zustand', 'Zustand'],
        ['@reduxjs/toolkit', 'Redux Toolkit'],
        ['recoil', 'Recoil'],
        ['jotai', 'Jotai'],
        ['mobx', 'MobX'],
        ['swr', 'SWR'],
        ['@tanstack/react-query', 'TanStack Query'],
        ['axios', 'Axios'],
        ['prisma', 'Prisma'],
        ['@prisma/client', 'Prisma'],
        ['drizzle-orm', 'Drizzle ORM'],
        ['mongoose', 'Mongoose'],
        ['typeorm', 'TypeORM'],
        ['sequelize', 'Sequelize'],
        ['graphql', 'GraphQL'],
        ['@apollo/client', 'Apollo Client'],
        ['trpc', 'tRPC'],
        ['@trpc/server', 'tRPC'],
        ['socket.io', 'Socket.IO'],
        ['ws', 'WebSocket'],
        ['redis', 'Redis'],
        ['ioredis', 'Redis'],
        ['bull', 'Bull Queue'],
        ['bullmq', 'BullMQ'],
      ];

      for (const [dep, name] of techMap) {
        if (deps?.[dep] && !techs.includes(name)) techs.push(name);
      }
    }

    // PHP dependencies
    const composer = safeReadJson('composer.json') as Record<string, Record<string, string>> | null;
    if (composer) {
      const req = { ...composer.require, ...composer['require-dev'] };

      const phpTechMap: [string, string][] = [
        ['predis/predis', 'Redis'],
        ['guzzlehttp/guzzle', 'Guzzle HTTP'],
        ['doctrine/dbal', 'Doctrine DBAL'],
        ['laravel/horizon', 'Laravel Horizon'],
        ['laravel/telescope', 'Laravel Telescope'],
        ['spatie/laravel-permission', 'Spatie Permissions'],
        ['openswoole/core', 'Swoole'],
      ];

      for (const [dep, name] of phpTechMap) {
        if (req?.[dep] && !techs.includes(name)) techs.push(name);
      }
    }

    return techs;
  });
}

function detectStructure(): string {
  return getCached('structure', () => {
    const structure: string[] = [];

    // Common directory patterns to check
    const dirs = [
      'src',
      'app',
      'lib',
      'pages',
      'components',
      'hooks',
      'utils',
      'helpers',
      'services',
      'api',
      'routes',
      'controllers',
      'models',
      'views',
      'templates',
      'public',
      'static',
      'assets',
      'styles',
      'tests',
      '__tests__',
      'spec',
      'config',
      'database',
      'migrations',
      'resources',
      'dist',
      'build',
    ];

    for (const dir of dirs) {
      const fullPath = join(PROJECT_ROOT, dir);
      if (existsSync(fullPath)) {
        try {
          const files = readdirSync(fullPath, { withFileTypes: true });
          const fileCount = files.filter((f) => f.isFile()).length;
          const dirCount = files.filter((f) => f.isDirectory()).length;
          structure.push(`${dir}/ (${fileCount} files, ${dirCount} subdirs)`);
        } catch {
          structure.push(`${dir}/`);
        }
      }
    }

    return structure.join('\n') || 'Standard structure';
  });
}

function detectConventions(): string[] {
  return getCached('conventions', () => {
    const conventions: string[] = [];
    const language = detectLanguage();
    const framework = detectFramework();

    // Language-specific conventions
    switch (language) {
      case 'TypeScript':
        conventions.push('TypeScript strict mode recommended');
        conventions.push('Interface/Type definitions for data structures');
        break;
      case 'JavaScript':
        conventions.push('ESLint/Prettier for code style');
        break;
      case 'PHP':
        conventions.push('PSR-4 autoloading');
        conventions.push('PSR-12 code style');
        break;
      case 'Python':
        conventions.push('PEP 8 style guide');
        conventions.push('Type hints (PEP 484)');
        break;
      case 'Go':
        conventions.push('gofmt for formatting');
        conventions.push('Effective Go guidelines');
        break;
      case 'Rust':
        conventions.push('rustfmt for formatting');
        conventions.push('Clippy lints');
        break;
    }

    // Framework-specific conventions
    if (framework.includes('Next')) {
      conventions.push('App Router or Pages Router structure');
      conventions.push('Server Components by default');
      conventions.push('API routes in app/api or pages/api');
    }
    if (framework.includes('React')) {
      conventions.push('Component naming: PascalCase');
      conventions.push('Hooks naming: use* prefix');
    }
    if (framework.includes('Laravel')) {
      conventions.push('Laravel naming conventions');
      conventions.push('Services in app/Services/ for business logic');
      conventions.push('Artisan commands in app/Console/Commands/');
    }
    if (framework.includes('Django')) {
      conventions.push('Django app structure');
      conventions.push('Models in models.py, views in views.py');
    }

    // Check for config files that indicate conventions
    if (
      existsSync(join(PROJECT_ROOT, '.eslintrc.json')) ||
      existsSync(join(PROJECT_ROOT, 'eslint.config.js'))
    ) {
      conventions.push('ESLint configured');
    }
    if (
      existsSync(join(PROJECT_ROOT, '.prettierrc')) ||
      existsSync(join(PROJECT_ROOT, 'prettier.config.js'))
    ) {
      conventions.push('Prettier configured');
    }
    if (existsSync(join(PROJECT_ROOT, 'biome.json'))) {
      conventions.push('Biome configured');
    }

    return conventions.length > 0 ? conventions : ['Standard conventions'];
  });
}

function detectPatterns(): string[] {
  return getCached('patterns', () => {
    const patterns: string[] = [];

    // Check for common architectural patterns
    const patternIndicators: [string, string][] = [
      ['src/components/ui', 'UI Component Library'],
      ['src/hooks', 'Custom Hooks Pattern'],
      ['src/store', 'Global State Management'],
      ['src/providers', 'Context Providers'],
      ['src/services', 'Service Layer'],
      ['src/repositories', 'Repository Pattern'],
      ['app/Services', 'Service Layer'],
      ['app/Repositories', 'Repository Pattern'],
      ['app/Events', 'Event-Driven Architecture'],
      ['app/Jobs', 'Queue/Job Pattern'],
      ['app/Http/Resources', 'API Resources/Transformers'],
      ['app/Policies', 'Authorization Policies'],
      ['middleware.ts', 'Edge Middleware'],
      ['src/lib/api', 'Centralized API Layer'],
    ];

    for (const [path, pattern] of patternIndicators) {
      if (existsSync(join(PROJECT_ROOT, path))) {
        patterns.push(pattern);
      }
    }

    return patterns;
  });
}

function detectIntegrations(): string[] {
  return getCached('integrations', () => {
    const integrations: string[] = [];

    // Check environment file for API keys
    const env = safeReadFile('.env') + safeReadFile('.env.local');

    const envIndicators: [string, string][] = [
      ['OPENAI', 'OpenAI'],
      ['ANTHROPIC', 'Anthropic'],
      ['STRIPE', 'Stripe'],
      ['REDIS', 'Redis'],
      ['DATABASE_URL', 'Database'],
      ['POSTGRES', 'PostgreSQL'],
      ['MYSQL', 'MySQL'],
      ['MONGO', 'MongoDB'],
      ['AWS_', 'AWS'],
      ['GOOGLE_', 'Google Cloud'],
      ['AZURE_', 'Azure'],
      ['SENTRY', 'Sentry'],
      ['DATADOG', 'Datadog'],
      ['TWILIO', 'Twilio'],
      ['SENDGRID', 'SendGrid'],
      ['MAILGUN', 'Mailgun'],
      ['SLACK', 'Slack'],
      ['DISCORD', 'Discord'],
    ];

    for (const [key, name] of envIndicators) {
      if (env.includes(key) && !integrations.includes(name)) {
        integrations.push(name);
      }
    }

    return integrations;
  });
}

function detectTestingStack(): string[] {
  return getCached('testingStack', () => {
    const stack: string[] = [];

    // Node.js testing
    const pkg = safeReadJson('package.json') as Record<string, Record<string, string>> | null;
    if (pkg) {
      const devDeps = pkg.devDependencies || {};

      const testTools: [string, string][] = [
        ['jest', 'Jest'],
        ['vitest', 'Vitest'],
        ['mocha', 'Mocha'],
        ['@testing-library/react', 'React Testing Library'],
        ['@testing-library/vue', 'Vue Testing Library'],
        ['cypress', 'Cypress'],
        ['playwright', 'Playwright'],
        ['@playwright/test', 'Playwright'],
        ['puppeteer', 'Puppeteer'],
        ['msw', 'MSW (Mock Service Worker)'],
        ['supertest', 'Supertest'],
        ['nock', 'Nock'],
      ];

      for (const [dep, name] of testTools) {
        if (devDeps[dep]) stack.push(name);
      }
    }

    // PHP testing
    const composer = safeReadJson('composer.json') as Record<string, Record<string, string>> | null;
    if (composer) {
      const devDeps = composer['require-dev'] || {};

      const phpTestTools: [string, string][] = [
        ['phpunit/phpunit', 'PHPUnit'],
        ['pestphp/pest', 'Pest'],
        ['mockery/mockery', 'Mockery'],
        ['laravel/dusk', 'Laravel Dusk'],
      ];

      for (const [dep, name] of phpTestTools) {
        if (devDeps[dep]) stack.push(name);
      }
    }

    // Python testing
    const pyDeps = safeReadFile('pyproject.toml') + safeReadFile('requirements.txt');
    if (pyDeps) {
      const pyTestTools: [string, string][] = [
        ['pytest', 'pytest'],
        ['unittest', 'unittest'],
        ['nose', 'nose'],
        ['hypothesis', 'Hypothesis'],
      ];

      for (const [dep, name] of pyTestTools) {
        if (pyDeps.toLowerCase().includes(dep)) stack.push(name);
      }
    }

    return stack;
  });
}

function getRecentlyModifiedFiles(): string[] {
  return getCached('recentlyModifiedFiles', () => {
    const language = detectLanguage();
    let extensions: string;

    switch (language) {
      case 'TypeScript':
        extensions = '-name "*.ts" -o -name "*.tsx"';
        break;
      case 'JavaScript':
        extensions = '-name "*.js" -o -name "*.jsx" -o -name "*.mjs"';
        break;
      case 'PHP':
        extensions = '-name "*.php"';
        break;
      case 'Python':
        extensions = '-name "*.py"';
        break;
      case 'Go':
        extensions = '-name "*.go"';
        break;
      case 'Rust':
        extensions = '-name "*.rs"';
        break;
      default:
        extensions =
          '-name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.php" -o -name "*.go"';
    }

    const cmd = `find "${PROJECT_ROOT}" -type f \\( ${extensions} \\) -mtime -7 2>/dev/null | grep -v node_modules | grep -v vendor | grep -v __pycache__ | head -20`;
    const longTimeout = config.get('timeouts').safeExec * 2; // Double the safe timeout for find
    const files = safeExec(cmd, longTimeout).split('\n').filter(Boolean);
    return files.map((f) => f.replace(PROJECT_ROOT + '/', ''));
  });
}

// ============================================================================
// MAIN CONTEXT GENERATOR
// ============================================================================

let cachedEnhancedContext: EnhancedProjectContext | null = null;
let cacheTime = 0;
const CACHE_TTL_MAIN = 300000; // 5 minutes

/**
 * Get enhanced project context with auto-detection
 * Results are cached for 5 minutes for performance
 * @returns {EnhancedProjectContext} Full project context object
 */
export function getEnhancedProjectContext(): EnhancedProjectContext {
  const now = Date.now();

  if (cachedEnhancedContext && now - cacheTime < CACHE_TTL_MAIN) {
    return cachedEnhancedContext;
  }

  Logger.debug(`Building enhanced project context for: ${PROJECT_ROOT}`);

  cachedEnhancedContext = {
    projectRoot: PROJECT_ROOT,
    language: detectLanguage(),
    framework: detectFramework(),
    runtime: detectRuntime(),
    packageManager: detectPackageManager(),
    mainTechnologies: detectTechnologies(),
    structure: detectStructure(),
    conventions: detectConventions(),
    commonPatterns: detectPatterns(),
    externalIntegrations: detectIntegrations(),
    testingStack: detectTestingStack(),
    recentlyModifiedFiles: getRecentlyModifiedFiles(),
  };

  Logger.debug(`Detected: ${cachedEnhancedContext.language} / ${cachedEnhancedContext.framework}`);
  cacheTime = now;
  return cachedEnhancedContext;
}

/**
 * Format project context as markdown for LLM prompts
 * @param {EnhancedProjectContext} context - Project context object
 * @returns {string} Formatted markdown string
 */
export function formatEnhancedContextForPrompt(context: EnhancedProjectContext): string {
  let output = `## 🏗️ Project Context

**Language:** ${context.language}
**Framework:** ${context.framework}
**Runtime:** ${context.runtime}
**Package Manager:** ${context.packageManager}
**Stack:** ${context.mainTechnologies.join(', ')}

### 📁 Structure
\`\`\`
${context.structure}
\`\`\`
`;

  if (context.commonPatterns.length > 0) {
    output += `
### 🎯 Architectural Patterns
${context.commonPatterns.map((p) => `- ${p}`).join('\n')}
`;
  }

  if (context.externalIntegrations.length > 0) {
    output += `
### 🌐 External Integrations
${context.externalIntegrations.map((i) => `- ${i}`).join('\n')}
`;
  }

  if (context.testingStack.length > 0) {
    output += `
### 🧪 Testing Stack
${context.testingStack.map((t) => `- ${t}`).join('\n')}
`;
  }

  if (context.conventions.length > 0) {
    output += `
### 📝 Coding Conventions
${context.conventions.map((c) => `- ${c}`).join('\n')}
`;
  }

  output += `\n---\n\n`;

  return output;
}

/**
 * Get formatted context string ready for prompt injection
 * Convenience wrapper around getEnhancedProjectContext + formatEnhancedContextForPrompt
 * @returns {string} Formatted markdown context string
 */
export function getEnhancedContextString(): string {
  return formatEnhancedContextForPrompt(getEnhancedProjectContext());
}

/** @deprecated Use string type directly */
export type ProjectType = string;

/**
 * Clear all cached project context data
 * Call this when project files change significantly
 */
export function clearProjectContextCache(): void {
  cachedEnhancedContext = null;
  localCache.clear();
  runtimeCache.clear();
  projectCache.clear(); // Clear the global project cache too
  Logger.debug('Project context cache cleared');
}
