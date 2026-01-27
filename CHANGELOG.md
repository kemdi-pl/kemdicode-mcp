# Changelog

All notable changes to KemdiCode MCP Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.14.0] - 2026-01-27

### Changed
- **Removed hardcoded apiBaseUrl**: Default configuration no longer includes a hardcoded OpenRouter URL
- **Improved type safety**: Added `ReasoningDelta` and `ReasoningMessage` types for reasoning models (DeepSeek, Kimi)
- **npm-ready package.json**: Added `exports`, `types`, `sideEffects`, `publishConfig` fields

### Fixed
- Removed `as any` casts in `ai/client.ts` for better type safety

## [1.13.2] - 2026-01-27

### Added
- **`auto-fix-agent` tool**: Multi-agent code fixing using OpenAI Agents SDK
  - Uses `applyPatchTool` for diff-based file patching
  - `WorkspaceEditor` implementing `Editor` interface
  - Path validation prevents operations outside workspace
  - Auto-backup before modifications
  - Configurable approval workflow for patches

### Fixed
- `auto-fix` tool now groups edits per file atomically (prevents file corruption)

## [1.13.1] - 2026-01-27

### Changed
- **Batch Agent Tools**: All agent management tools now support 1-20 items per call
  - `agent-register`: Register multiple agents at once
  - `agent-summary`: Update multiple agent summaries in parallel
  - `queue-message`: Individual messages array or broadcast mode
- **Batch Kanban Tools**: Task operations now support 1-20 items per call
  - `task-create`: Create multiple tasks at once
  - `task-update`: Update multiple tasks in parallel
  - `task-assign`: Assign multiple tasks to different agents

### Removed
- `pop-queue` tool (messages consumed via queue-message broadcast)

## [1.13.0] - 2026-01-26

### Added
- **Session Monitor Tool** (`monitor`): Comprehensive multi-agent monitoring
  - 5 views: `overview`, `agents`, `tasks`, `hierarchy`, `activity`
  - Hierarchical display: Session → Workspaces → Boards → Tasks → Agents
  - Real-time agent status with activity summaries
  - Message queue depth tracking
- **Agent Summary Tool** (`agent-summary`): Agents report current activity
- **Message Queue System**: Supervisor-to-agent communication
  - `queue-message`: Queue messages with priority
  - File attachments and context change support

## [1.12.3] - 2026-01-25

### Changed
- **Migrated to official OpenAI SDK**: Replaced custom fetch-based client
  - Built-in retry and rate limiting via SDK
  - Removed `providers.ts` and `rate-limiter.ts`
- **No hardcoded defaults**: Package is now fully configurable

### Breaking
- Configuration required before use (apiBaseUrl, apiKey, primaryModel)

## [1.12.2] - 2026-01-24

### Security
- **CRITICAL**: Fixed weak key derivation with HKDF
- **CRITICAL**: Added HMAC signature verification for agent identity
- **CRITICAL**: Removed plaintext secret from output
- **HIGH**: Validates EncryptedData structure before decryption
- **HIGH**: Added entropy validation for MPC_MASTER_SECRET
- **HIGH**: Enforced Redis password in production

## [1.12.1] - 2026-01-23

### Added
- **`ai-models` tool**: Dynamic model listing and selection
- **MPC Security Hardening**: Role-based authorization

### Fixed
- `ai-config` API key updates now work correctly

## [1.12.0] - 2026-01-22

### Added
- **Workspace system**: Cross-session collaboration
- **Multi-board support**: Multiple boards per session
- **Task push to N agents**: `task-push-multi` for supervisor-driven assignment
- **Role-based permissions**: owner/admin/member/viewer per board

### Fixed
- Recursive invocation now works (depth 2 limit)

## [1.11.0] - 2026-01-20

### Added
- **Bun runtime support**: Full compatibility with Bun 1.0+
- **Runtime abstraction layer**: Cross-runtime compatibility
- **GPL-3.0 license headers**: All source files
- **ai-config tool**: Manage AI provider settings at runtime

## [1.10.0] - 2026-01-18

### Added
- **Agent Kanban system**: Task management for multi-agent workflows
- **Recursive tool invocation**: `invoke-tool`, `invoke-batch`, `invocation-log`
- **Tree-sitter integration**: WASM-based AST parsing for 19 languages

## [1.9.0] - 2026-01-15

### Added
- **Line-based editing**: `insert-at-line`, `delete-lines`, `replace-lines`, `replace-content`
- **Symbol-based editing**: `insert-before-symbol`, `insert-after-symbol`, `rename-symbol`
- **Project memory**: `write-memory`, `read-memory`, `list-memories`, `delete-memory`, `edit-memory`

## [1.8.2] - 2025-12-29

### Added
- `shared-thoughts` tool for reading collective knowledge base from all agents
- Session ID displayed at server startup for multi-agent coordination
- Scope filtering for shared thoughts (all, opencode, php-servers, analysis, code)
- Multiple output formats (summary, timeline, detailed)

## [1.8.1] - 2025-12-26

### Added
- ESLint with TypeScript support and strict rules
- Prettier for consistent code formatting

### Security
- `opencode.json` now in `.gitignore` (contains API keys)

### Changed
- Replaced `any` types with `unknown` for better type safety

## [1.8.0] - 2025-12-25

### Added
- **Batch Tool**: Execute multiple operations in parallel with single request
- Graceful shutdown with cleanup
- Port conflict detection and automatic cleanup

### Changed
- Major performance improvement for parallel tool execution

## [1.7.0] - 2025-12-24

### Added
- HTTP transport as default mode
- Per-request progress state isolation
- Health check endpoint at `/health`
- Session management with automatic cleanup

## [1.6.0] - 2025-12-23

### Added
- **Agent Monitoring**: Real-time multi-agent supervision via Redis Pub/Sub
- Agent tools: `agent-list`, `agent-register`, `agent-watch`, `agent-alert`, `agent-inject`, `agent-history`
- Inter-agent messaging with priorities and types

## [1.5.0] - 2025-12-22

### Changed
- Package updates and dependency upgrades
- Bug fixes for edge cases

## [1.4.0] - 2025-12-21

### Changed
- Default model changed to MiniMax M2
- Fallback model changed to Gemini 2.5 Flash

## [1.3.0] - 2025-12-20

### Added
- Multi-agent context sharing via Redis
- `get-shared-context` tool for retrieving context from other MCP servers

## [1.2.0] - 2025-12-19

### Added
- Initial public release
- Specialized tools: `code-review`, `explain-code`, `fix-bug`, `refactor`, `write-tests`, `analyze-deps`, `auto-fix`
- `ask-opencode`, `plan`, `build` agent tools
- `brainstorm` creative ideation tool

## [1.1.0] - 2025-12-18

### Added
- Tool registry with Zod schema validation
- Automatic JSON Schema generation for MCP protocol
- Progress streaming support

## [1.0.0] - 2025-12-17

### Added
- Initial development version
- Basic MCP server implementation
