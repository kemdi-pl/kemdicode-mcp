# Recursive Tool Invocation

Agents can invoke other MCP tools programmatically for complex workflows.

## 1. Single tool invocation

```json
invoke-tool --toolName "semantic-search" --args '{"query": "authentication middleware", "language": "typescript", "limit": 10}' --agentId "worker-1" --sessionId "session-1" --dryRun false
```

## 2. Dry run (check permissions without executing)

```json
invoke-tool --toolName "ask-ai" --args '{"prompt": "Explain this code", "files": "@src/index.ts"}' --agentId "worker-1" --sessionId "session-1" --dryRun true
```

## 3. Batch parallel execution

```json
invoke-batch --agentId "worker-1" --sessionId "session-1" --parallel true --stopOnError false --operations '[
  {"toolName": "find-definition", "args": {"symbol": "PaymentService", "language": "typescript"}, "id": "find-payment"},
  {"toolName": "find-references", "args": {"symbol": "PaymentService", "language": "typescript"}, "id": "refs-payment"},
  {"toolName": "semantic-search", "args": {"query": "error handling", "language": "typescript", "limit": 5}, "id": "search-errors"}
]'
```

## 4. Sequential batch (with stop on error)

```json
invoke-batch --agentId "worker-1" --sessionId "session-1" --parallel false --stopOnError true --operations '[
  {"toolName": "find-definition", "args": {"symbol": "AuthMiddleware", "language": "typescript"}, "id": "find-auth"},
  {"toolName": "find-references", "args": {"symbol": "AuthMiddleware", "language": "typescript"}, "id": "refs-auth"},
  {"toolName": "write-tests", "args": {"files": "@src/auth/middleware.ts", "type": "unit", "coverage": "full"}, "id": "gen-tests"}
]'
```

## 5. View invocation history

```
invocation-log --agentId "worker-1" --limit 20 --includeContext true
```
