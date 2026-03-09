# Session Recovery & Client Capabilities

Advanced features for session continuity and leveraging MCP client capabilities.

## Session Recovery

After context compaction or a new session, restore full context in a single call:

```
session-recover
```

This orchestrates:
1. Active session memory restore
2. Latest handoff retrieval
3. Loci (knowledge graph) resurrection
4. Tool availability check
5. Agent rankings reload
6. Ambient learning insights

### Manual session management

```
session-list
session-info --sessionId "current"
session-create --name "Feature Branch Work"
session-switch --sessionId "session-xyz"
session-delete --sessionId "old-session"
```

## Client Capabilities Bridge

Leverage the connected MCP client's own capabilities:

### Request completion via client's model

```json
client-sampling --prompt "Summarize the last 5 commits" \
  --maxTokens 500
```

Uses the client's (e.g., Claude Code's) own model and API keys — no kemdiCode MCP API key needed.

### Ask structured questions via client UI

```json
client-elicit --title "Deployment Target" \
  --description "Where should we deploy this service?" \
  --fields '[{"name": "environment", "type": "enum", "options": ["staging", "production"]}, {"name": "replicas", "type": "number"}, {"name": "skipTests", "type": "boolean"}]'
```

Displays a form in the client UI and returns structured responses.

### List client workspace roots

```
client-roots
```

Returns the directories/projects the MCP client currently has open.
