# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.14.6] - 2026-01-29

### Fixed
- **CRITICAL**: Fixed race condition in `claimTask` (kanban-store.ts) using atomic Lua script
- **CRITICAL**: Added try-catch around all `JSON.parse` calls in agent-monitor.ts to prevent crashes
- **CRITICAL**: Fixed memory leak in progress.ts interval cleanup
- **CRITICAL**: Added proper SIGTERM/SIGINT handlers for graceful shutdown
- **CRITICAL**: Fixed Redis connection cleanup in subscribeToEvents with error handling
- **SECURITY**: Added path validation to file-diff.tool.ts (path traversal protection)
- **SECURITY**: Added path validation to file-tree.tool.ts (path traversal protection)

### Changed
- Updated package.json prepare script to not run format (only build)
- Fixed repository URL format in package.json (added git+ prefix)
- Synchronized README.md version badge with package.json (1.14.6)

### Removed
- Cleaned up stale files in dist/ directory

## [1.14.0] - 2026-01-20

### Added
- Multi-board Kanban system with workspaces
- 100+ MCP tools for code analysis
- Tree-sitter AST support for 19 languages
- Multi-agent coordination via Redis
- Recursive tool invocation (2-level depth)
- Bun + Node.js cross-runtime support
- Hot-reload configuration

### Features
- AI Agents: plan, build, brainstorm, ask-ai
- Code Analysis: code-review, explain-code, find-definition, semantic-search
- Git Operations: git-status, git-diff, git-log, git-blame, git-branch
- File Operations: file-read, file-write, file-search, file-tree, file-diff
- Kanban: task-create, task-list, task-update, board-create, workspace-create
- Multi-Agent: agent-register, queue-message, shared-thoughts, monitor

[1.14.6]: https://git.kemdi.pl/Kemdi/kemdicode-mcp/compare/v1.14.0...v1.14.6
[1.14.0]: https://git.kemdi.pl/Kemdi/kemdicode-mcp/releases/tag/v1.14.0
