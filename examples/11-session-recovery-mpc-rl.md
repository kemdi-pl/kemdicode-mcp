# Session Recovery, MPC Security & Reinforcement Learning

Advanced features for session continuity, secret management, and adaptive agent behavior.

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

## MPC Security — Shamir Secret Sharing

Split sensitive data across multiple parties so no single party can reconstruct the secret alone.

### Split a secret into shares

```json
mpc-split --secret "sk-prod-api-key-very-sensitive-12345" \
  --totalShares 5 \
  --threshold 3 \
  --label "Production API Key"
```

This creates 5 shares. Any 3 of them can reconstruct the original secret.

### Distribute shares to agents

```json
mpc-distribute --splitId "split-id" \
  --assignments '[{"shareIndex": 0, "holderId": "agent-a"}, {"shareIndex": 1, "holderId": "agent-b"}, {"shareIndex": 2, "holderId": "agent-c"}, {"shareIndex": 3, "holderId": "agent-d"}, {"shareIndex": 4, "holderId": "agent-e"}]'
```

### Reconstruct with threshold shares

```json
mpc-reconstruct --splitId "split-id" \
  --shares '[{"shareIndex": 0, "value": "share-value-0"}, {"shareIndex": 2, "value": "share-value-2"}, {"shareIndex": 4, "value": "share-value-4"}]'
```

Only 3 of 5 shares needed — the other 2 holders don't need to participate.

### Check MPC status

```
mpc-status --splitId "split-id"
```

### Use case: Secure deployment credentials

```
1. DevOps splits production DB password into 3 shares (threshold: 2)
2. Distributes to: CI/CD agent, deployment agent, monitoring agent  
3. During deploy, CI/CD + deployment agents combine shares to reconstruct
4. Monitoring agent alone cannot access the password
```

## Reinforcement Learning

Track agent performance with reward signals and dopamine-inspired learning.

### Log dopamine events (positive/negative feedback)

```json
rl-dopamine-log --action "log" \
  --agentId "backend-dev" \
  --event "task-completed" \
  --reward 1.0 \
  --context "Completed auth middleware with 100% test coverage"

rl-dopamine-log --action "log" \
  --agentId "backend-dev" \
  --event "task-failed" \
  --reward -0.5 \
  --context "Introduced regression in payment flow"
```

### View reward statistics

```json
rl-reward-stats --agentId "backend-dev" --period "7d"
rl-reward-stats --agentId "backend-dev" --period "30d"
```

Reward stats feed into the agent ranking system, influencing tier progression.

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
