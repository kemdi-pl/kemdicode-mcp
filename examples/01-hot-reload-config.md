# Hot Reload Configuration

Switch AI providers, models, and settings at runtime without restarting the server.

## Switch to OpenRouter with a free model

```
ai-config --action set --provider openrouter --apiKey "sk-or-v1-..." --primaryModel "liquid/lfm-2.5-1.2b-thinking:free"
```

## Switch to local Ollama

```
ai-config --action set --provider ollama --primaryModel "llama3.1:8b"
```

## Test connection after switching

```
ai-config --action test
```

## View current configuration

```
ai-config --action get
```

## List available models from current provider

```
ai-models --action list --limit 20
```

## Search for a specific model

```
ai-models --action search --filter "deepseek"
```

## Set fallback model for quota errors

```
ai-config --action set --primaryModel "gpt-4.1" --fallbackModel "gpt-4.1-mini"
```

## Full provider cycle (no restart needed)

```bash
# 1. Start with OpenAI
ai-config --action set --provider openai --apiKey "sk-..." --primaryModel "gpt-4.1"

# 2. Test it
ask-ai --prompt "Hello" --agent general

# 3. Switch to Anthropic mid-session
ai-config --action set --provider anthropic --apiKey "sk-ant-..." --primaryModel "claude-sonnet-4-6"

# 4. Use multi-provider syntax (no config change needed)
multi-prompt --prompt "Explain TCP" --models '["o:gpt-4.1", "a:claude-sonnet-4-6"]'
```
