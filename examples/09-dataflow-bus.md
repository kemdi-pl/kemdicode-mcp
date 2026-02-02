# Data Flow Bus

Typed message bus with 12 channels for structured inter-module communication. Provides publish/subscribe, correlation tracking, priority routing, and Redis bridge for cross-session propagation.

## Channel Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Data Flow Bus                         │
├──────────────┬──────────────┬──────────────┬────────────┤
│  AI Channels │ Kanban Chan. │ Cognition Ch.│ System Ch. │
│              │              │              │            │
│ ai:completion│ kanban:      │ cognition:   │ system:    │
│ ai:structured│  task-change │  decision    │  health    │
│ ai:research  │ kanban:      │ cognition:   │ system:    │
│              │  complexity  │  intent      │  config    │
├──────────────┤              │ cognition:   ├────────────┤
│ Agent Chan.  │              │  error       │            │
│              │              │              │            │
│ agent:status │              │              │            │
│ agent:message│              │              │            │
└──────────────┴──────────────┴──────────────┴────────────┘
         │              │             │            │
         └──────────────┴─────────────┴────────────┘
                        │
                  Redis Pub/Sub
              (cross-session sync)
```

## The 12 Channels

| Channel | Payload | Description |
|---------|---------|-------------|
| `ai:completion` | model, tokens, content, tier | AI completion results from any provider |
| `ai:structured` | model, tokens, content | Structured output (generateObject) results |
| `ai:research` | model, tokens, content, tier | Research-tier model responses (Perplexity) |
| `kanban:task-change` | taskId, action, status | Task lifecycle events (created/updated/completed/claimed/deleted) |
| `kanban:complexity` | taskId, score, subtasks, reasoning | LLM complexity analysis results |
| `cognition:decision` | decisionId, question, chosen, confidence | Decision journal entries |
| `cognition:intent` | (flexible) | Intent hierarchy changes and drift alerts |
| `cognition:error` | (flexible) | Error pattern matches from cross-session DB |
| `agent:status` | agentId, status, currentTask | Agent online/busy/idle/offline transitions |
| `agent:message` | (flexible) | Inter-agent communication messages |
| `system:health` | component, status, metrics | Component health (healthy/degraded/down) |
| `system:config` | (flexible) | Runtime configuration change events |

## How It Works in Practice

The Data Flow Bus operates automatically behind the scenes. When you use MCP tools, they publish and subscribe to channels:

**AI completions flow:**
```
ask-ai → publishes to ai:completion → cognition module subscribes → logs decision context
```

**Task lifecycle flow:**
```
task-update → publishes to kanban:task-change → agent module subscribes → notifies assigned agent
```

**Error learning flow:**
```
auto-fix detects error → publishes to cognition:error → error-pattern store subscribes → 
  matches against cross-session DB → suggests fix from past solutions
```

**Health monitoring flow:**
```
tool-health check → publishes to system:health → monitor subscribes → 
  alerts if component degraded
```

## Message Envelope

Every message on the bus follows the `DataFlowEnvelope` protocol:

```typescript
{
  id: "uuid-v4",              // Unique message ID
  channel: "ai:completion",    // One of 12 typed channels
  payload: { ... },            // Channel-specific typed payload
  source: "ai-client",         // Source module
  target: "cognition",         // Optional: directed delivery
  sessionId: "session-123",    // Session context
  agentId: "worker-1",         // Agent context
  timestamp: 1700000000000,    // Creation time
  correlationId: "corr-456",   // Trace message chains
  schemaVersion: 1,            // Payload compatibility
  priority: 2,                 // 0=low, 1=normal, 2=high, 3=critical
  ttl: 3600                    // Seconds until expiry (0=never)
}
```

## Subscription Options

```typescript
{
  sourceFilter: ["ai-client"],  // Only messages from specific modules
  minPriority: 2,               // Only high/critical messages
  sequential: true               // Process in order (default: parallel)
}
```

## Correlation Tracking

Messages sharing a `correlationId` form a traceable chain:

```
user request (corr-001)
  → ai:completion (corr-001)
    → cognition:decision (corr-001)
      → kanban:task-change (corr-001)
```

This allows full request tracing across modules.

## Cross-Session via Redis

When Redis is connected, the Data Flow Bus bridges messages through Pub/Sub. Messages published in Session A appear in Session B — enabling:
- Multi-agent coordination across separate Claude Code instances
- Shared health monitoring across all connected sessions
- Cross-session error pattern learning
