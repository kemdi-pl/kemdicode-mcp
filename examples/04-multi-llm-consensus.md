# Multi-LLM Consensus Decisions

Use multiple AI models in parallel and synthesize their responses.

## Model Spec Syntax

```
provider:model:thinking

Aliases: o=OpenAI, a=Anthropic, g=Gemini, q=Groq, d=DeepSeek, l=Ollama, r=OpenRouter
Thinking: :low/:medium/:high (OpenAI), :4k/:8k (Anthropic/Gemini token budget)
```

## 1. Compare responses from multiple models

```json
multi-prompt --prompt "What are the trade-offs of microservices vs monolith for a 5-person team?" --models '["o:gpt-4.1", "a:claude-sonnet-4-6", "g:gemini-2.5-pro"]' --agent "plan"
```

## 2. CEO-and-Board decision pattern

```json
consensus-prompt --prompt "Should we migrate from REST to GraphQL? Our API has 50 endpoints, 10k daily users, and a team of 3 backend devs." --boardModels '["o:gpt-4.1", "a:claude-sonnet-4-6", "g:gemini-2.5-flash"]' --ceoModel "a:claude-sonnet-4-6" --agent "plan"
```

## 3. Code review consensus

```json
consensus-prompt --prompt "Review this authentication implementation for security issues" --files "@src/auth/middleware.ts @src/auth/jwt.ts" --boardModels '["o:gpt-4.1", "a:claude-sonnet-4-6"]' --ceoModel "o:o3:high" --agent "plan"
```

## 4. Architecture decision with thinking tokens

```json
multi-prompt --prompt "Design a real-time notification system for 1M concurrent users" --models '["o:o3:high", "a:claude-sonnet-4-6:4k", "g:gemini-2.5-pro:8k"]' --agent "plan"
```

## 5. Quick parallel comparison with free models

```json
multi-prompt --prompt "Write a TypeScript debounce function" --models '["r:liquid/lfm-2.5-1.2b-thinking:free", "o:gpt-4.1-mini"]' --agent "build"
```
