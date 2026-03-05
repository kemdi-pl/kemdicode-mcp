# Configuration Files

Example configuration files for KemdiCode MCP Server.

## Server Configuration

| File | Description |
|------|-------------|
| `kemdicode-mcp.example.json` | Main server config (port, model, Redis). Copy to `.kemdicode-mcp.json` in project root. |

## IDE Integration

| File | IDE | Runtime | Notes |
|------|-----|---------|-------|
| `mcp-settings.claude-code.example.json` | Claude Code | Node.js | Place in `~/.claude/settings/` |
| `mcp-settings.cursor.example.json` | Cursor | Node.js | Uses `--stdio` flag. Place in `.cursor/mcp.json` |
| `mcp-settings.kirocode.example.json` | KiroCode | Bun | Place in `.kiro/settings/mcp.json` |
| `mcp-settings.roocode.example.json` | RooCode | Bun | Configure in VS Code extension settings |

## Setup

1. Copy the server config:
   ```bash
   cp config/kemdicode-mcp.example.json .kemdicode-mcp.json
   ```

2. Edit `.kemdicode-mcp.json` with your API key and preferred model.

3. Copy the IDE config for your editor and update the path to `dist/index.js`.

## Environment Variables

Alternative to config file - set via environment:

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GEMINI_API_KEY="AI..."
export GROQ_API_KEY="gsk_..."
export OPENROUTER_API_KEY="sk-or-..."
```

## Hot Reload

Configuration can be changed at runtime without restart:

```
ai-config --action set --provider openrouter --apiKey "sk-or-..." --primaryModel "model-name"
```

See [examples/01-hot-reload-config.md](../examples/01-hot-reload-config.md) for details.
