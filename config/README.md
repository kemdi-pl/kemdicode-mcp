# Configuration Files

Example configuration files for kemdiCode MCP Server v4.2.0.

## Server Configuration

| File | Description |
|------|-------------|
| `kemdicode-mcp.example.json` | Main server config (port, model, Redis). Copy to `.kemdicode-mcp.json` in project root. |

## IDE Integration

Two transport modes:

- **stdio** (subprocess) — IDE starts kemdicode-mcp as a child process. Recommended for single-session use.
- **HTTP** (Streamable HTTP) — kemdicode-mcp runs as a standalone server. Required for multi-session or remote access.

### Quick Setup (npm global install)

```bash
bun install -g kemdicode-mcp
```

After global install, use `kemdicode-mcp` as the command (no need for full path).

### Quick Setup (from source)

```bash
git clone https://github.com/kemdi-pl/kemdicode-mcp.git
cd kemdicode-mcp && bun install && bun run build
```

Then use `bun /path/to/kemdicode-mcp/dist/index.js` as the command.

## IDE Configs

| File | IDE | Transport | Config Location |
|------|-----|-----------|-----------------|
| `mcp-settings.claude-code.example.json` | Claude Code | stdio | `claude mcp add` CLI |
| `mcp-settings.cursor.example.json` | Cursor | stdio | `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| `mcp-settings.windsurf.example.json` | Windsurf | stdio | `~/.codeium/windsurf/mcp_config.json` |
| `mcp-settings.vscode.example.json` | VS Code (Copilot) | stdio | `.vscode/mcp.json` |
| `mcp-settings.zed.example.json` | Zed | stdio | `~/.config/zed/settings.json` (inside `context_servers`) |
| `mcp-settings.kirocode.example.json` | KiroCode | stdio | `.kiro/settings/mcp.json` |
| `mcp-settings.roocode.example.json` | RooCode | stdio | VS Code extension settings |

For HTTP transport, start the server first:

```bash
kemdicode-mcp --port 3100
```

Then point your IDE to `http://127.0.0.1:3100/mcp`.

## Environment Variables

Set API keys for LLM providers:

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GEMINI_API_KEY="AI..."
export GROQ_API_KEY="gsk_..."
export DEEPSEEK_API_KEY="sk-..."
export OPENROUTER_API_KEY="sk-or-..."
export PERPLEXITY_API_KEY="pplx-..."
```

## Hot Reload

Configuration can be changed at runtime without restart:

```
ai-config --action set --provider openrouter --apiKey "sk-or-..." --primaryModel "model-name"
```

See [examples/01-hot-reload-config.md](../examples/01-hot-reload-config.md) for details.
