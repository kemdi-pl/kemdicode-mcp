# Code Analysis Workflow

Code intelligence and error investigation using kemdiCode MCP tools.

## 1. Find a symbol definition

```
find-definition --symbol "PaymentService" --language "typescript"
```

## 2. Find all references to a symbol

```
find-references --symbol "PaymentService" --language "typescript"
```

## 3. Semantic search across the codebase

```
semantic-search --query "authentication middleware" --language "typescript" --limit 10
```

## 4. Investigate a bug with structured reasoning

```json
thinking-chain --action "start" \
  --title "Debug payment webhook failure" \
  --thought "Webhook returns 500 when processing Stripe events"

thinking-chain --action "think" \
  --chainId "chain-id" \
  --thought "The error occurs in webhook handler — checking payload structure" \
  --confidence 60

thinking-chain --action "conclude" \
  --chainId "chain-id" \
  --conclusion "Root cause: missing null check on payload.data.object.id"
```

## 5. Check for known error patterns

```json
error-pattern --action "match" --sessionId "project-x" \
  --error "TypeError: Cannot read properties of undefined (reading 'id')"

error-pattern --action "record" --sessionId "project-x" \
  --error "TypeError: Cannot read properties of undefined (reading 'id')" \
  --context "Processing webhook payload from Stripe" \
  --fix "Add null check: payload?.data?.object?.id" \
  --tags '["typescript", "stripe", "null-safety"]'
```

## 6. Generate tests for a module

```
write-tests --files "@src/mpc/redis-store.ts" --type "both" --coverage "full"
```

## 7. Ask AI to analyze code

```json
ask-ai --prompt "Review this authentication middleware for security issues" \
  --files "@src/auth/middleware.ts @src/auth/jwt.ts" \
  --agent "plan"
```

## 8. Multi-model code review consensus

```json
consensus-prompt --prompt "Review this payment service for security and performance issues" \
  --files "@src/services/payment.ts" \
  --boardModels '["o:gpt-4.1", "a:claude-sonnet-4-6"]' \
  --ceoModel "o:o3:high" \
  --agent "plan"
```
