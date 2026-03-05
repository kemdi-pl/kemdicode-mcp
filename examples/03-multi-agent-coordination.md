# Multi-Agent Coordination

Orchestrate multiple AI agents working on the same codebase.

## 1. Register a team of specialized agents

```json
agent-register --sessionId "project-alpha" --serverId "kemdicode-mcp" --agents '[
  {"name": "Architect", "role": "supervisor", "model": "gpt-4o"},
  {"name": "Frontend Dev", "role": "worker", "model": "claude-sonnet-4-20250514"},
  {"name": "Backend Dev", "role": "worker", "model": "gpt-4o"},
  {"name": "QA Agent", "role": "specialist", "model": "gemini-2.5-pro"}
]'
```

## 2. Send directive to all agents

```
agent-alert --agentIds "*" --message "All services must use TypeScript strict mode" --source "Architect" --priority "high" --interrupt false
```

## 3. Inject context into a specific agent

```
agent-inject --agentId "frontend-dev" --sessionId "project-alpha" --type "context" --content "The design system uses Tailwind CSS v4 with custom tokens in tokens.css"
```

## 4. Share knowledge between agents

```
shared-thoughts --scope "all" --limit 20 --format "summary" --includeOutput false
```

## 5. Monitor agent activity in real-time

```
agent-watch --sessionId "project-alpha" --duration 30000 --messageLimit 50
```

## 6. View agent conversation history

```
agent-history --sessionId "project-alpha" --limit 50 --type "all"
```

## 7. Queue messages for offline agents

```json
queue-message (broadcast mode to all agents with content "Deploy freeze at 5 PM")
```

## 8. Session-wide monitoring

```
monitor --sessionId "project-alpha" --view overview --depth shallow
monitor --sessionId "project-alpha" --view agents --depth deep
monitor --sessionId "project-alpha" --view activity --limit 30
```
