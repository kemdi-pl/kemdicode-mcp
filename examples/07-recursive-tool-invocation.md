# Recursive Tool Invocation

Agents can invoke other MCP tools programmatically for complex workflows.

## 1. Single tool invocation

```json
invoke-tool --toolName "file-read" --args '{"path": "src/index.ts", "encoding": "utf-8"}' --agentId "worker-1" --sessionId "session-1" --dryRun false
```

## 2. Dry run (check permissions without executing)

```json
invoke-tool --toolName "shell-exec" --args '{"command": "npm test"}' --agentId "worker-1" --sessionId "session-1" --dryRun true
```

## 3. Batch parallel execution

```json
invoke-batch --agentId "worker-1" --sessionId "session-1" --parallel true --stopOnError false --operations '[
  {"toolName": "file-read", "args": {"path": "src/a.ts", "encoding": "utf-8"}, "id": "read-a"},
  {"toolName": "file-read", "args": {"path": "src/b.ts", "encoding": "utf-8"}, "id": "read-b"},
  {"toolName": "git-status", "args": {"short": true, "branch": true, "showStash": false, "ignored": false, "untracked": "normal"}, "id": "status"}
]'
```

## 4. Sequential batch (with stop on error)

```json
invoke-batch --agentId "worker-1" --sessionId "session-1" --parallel false --stopOnError true --operations '[
  {"toolName": "run-lint", "args": {"linter": "auto", "fix": false, "timeout": 60000}, "id": "lint"},
  {"toolName": "check-types", "args": {"checker": "auto", "timeout": 60000, "strict": false}, "id": "types"},
  {"toolName": "run-tests", "args": {"framework": "auto", "coverage": false, "timeout": 120000, "watch": false}, "id": "test"}
]'
```

## 5. View invocation history

```
invocation-log --agentId "worker-1" --limit 20 --includeContext true
```
