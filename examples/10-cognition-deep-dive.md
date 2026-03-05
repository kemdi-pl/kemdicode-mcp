# Cognition Deep Dive

Advanced patterns for the 8-tool cognition layer: ambient learning, agent ranking, cross-tool intelligence, and session continuity.

## Ambient Learning

The ambient learner silently observes your workflow and builds knowledge:
- **Tool sequences** — learns which tools you use together (e.g., code-review → auto-fix → run-tests)
- **File relationships** — tracks which files are modified together
- **Time patterns** — when you're most productive, how long tasks take

This happens automatically. No tool calls needed — it learns from every MCP interaction.

## 1. Agent Ranking (Bronze → Diamond)

Agents earn rankings based on composite scoring: task completion rate, quality, speed, and consistency.

```
agent-rank --action "view" --agentId "backend-dev"
agent-rank --action "leaderboard" --limit 10
```

**Tier progression:**
| Tier | Score Range | Meaning |
|------|:-----------:|------|
| Bronze | 0–20 | New agent, limited history |
| Silver | 21–40 | Consistent contributor |
| Gold | 41–60 | High-quality work |
| Platinum | 61–80 | Expert-level performance |
| Diamond | 81–100 | Top performer with sustained excellence |

Rankings decay over time if the agent is inactive, preventing stale high scores.

## 2. Decision Journal with Cross-Links

Record architectural decisions with full context. Decisions auto-link to confidence records and error patterns.

```json
decision-journal --action "record" --sessionId "project-x" \
  --question "Which message queue for async processing?" \
  --options '["Redis Streams", "RabbitMQ", "SQS"]' \
  --chosen "Redis Streams" \
  --reasoning "Already using Redis for caching, reduces operational complexity. Streams provide consumer groups and acknowledgment. SQS adds AWS dependency we want to avoid." \
  --confidence 0.85 \
  --tags '["architecture", "messaging", "redis"]'
```

**Cross-tool reaction chain:**
```
decision-journal:record
  → auto-creates confidence-tracker entry (0.85)
  → cross-linker creates bidirectional Redis link
  → if confidence < 0.5, triggers intent drift detection
```

## 3. Confidence Tracking with Calibration

```json
confidence-tracker --action "record" --sessionId "project-x" \
  --area "Redis Streams implementation" \
  --score 0.85 \
  --reasoning "Familiar with Redis, but first time using Streams consumer groups"

confidence-tracker --action "calibrate" --sessionId "project-x"
confidence-tracker --action "trends" --sessionId "project-x" --limit 20
```

## 4. Mental Model with Impact Analysis

Build a persistent mental model of your system architecture.

```json
mental-model --action "create" --sessionId "project-x" \
  --name "Payment System" \
  --description "End-to-end payment processing architecture" \
  --tags '["architecture", "payments"]'

mental-model --action "add-component" --sessionId "project-x" \
  --modelId "model-id" \
  --componentName "PaymentGateway" \
  --componentRole "Handles Stripe/PayPal integration and webhook processing" \
  --componentFiles '["src/payments/gateway.ts", "src/payments/webhooks.ts"]' \
  --componentDependencies '["OrderService", "UserService"]' \
  --componentInvariants '["All amounts in cents", "Idempotency keys required"]'

mental-model --action "add-relationship" --sessionId "project-x" \
  --modelId "model-id" \
  --from "PaymentGateway" --to "OrderService" \
  --relationshipType "calls" \
  --protocol "Redis Pub/Sub" \
  --relationshipDescription "Publishes payment.completed events"

mental-model --action "impact-analysis" --sessionId "project-x" \
  --modelId "model-id" \
  --componentName "PaymentGateway"

mental-model --action "dependency-chain" --sessionId "project-x" \
  --modelId "model-id" \
  --componentName "OrderService"
```

## 5. Intent Tracking with Drift Detection

```json
intent-tracker --action "set-mission" --sessionId "project-x" \
  --content "Migrate payment system from Stripe v1 to v2 API"

intent-tracker --action "push-goal" --sessionId "project-x" \
  --content "Update webhook handlers for v2 event format"

intent-tracker --action "check-drift" --sessionId "project-x"
```

Drift detection compares current work against declared intents and warns if you're going off-track.

## 6. Error Pattern Database

```json
error-pattern --action "record" --sessionId "project-x" \
  --error "TypeError: Cannot read properties of undefined (reading 'id')" \
  --context "Processing webhook payload from Stripe" \
  --fix "Add null check: payload?.data?.object?.id" \
  --tags '["typescript", "stripe", "null-safety"]'

error-pattern --action "match" --sessionId "project-x" \
  --error "TypeError: Cannot read properties of undefined"

error-pattern --action "stats" --sessionId "project-x"
```

Matching searches the cross-session error database for similar errors and returns proven fixes.

## 7. Self-Critique & Lessons

```json
self-critique --action "reflect" --sessionId "project-x" \
  --summary "Completed Stripe v2 migration" \
  --successes '["All webhook handlers updated", "Zero downtime deployment"]' \
  --failures '["Forgot to update test fixtures initially"]' \
  --lessons '["Always update test fixtures when changing API response shapes"]'

self-critique --action "check-application" --sessionId "project-x"
```

`check-application` verifies whether lessons from past critiques are being applied in current work.

## 8. Smart Handoff

Create a structured briefing for session continuity.

```json
smart-handoff --action "create" --sessionId "project-x" \
  --summary "Stripe v2 migration 80% complete" \
  --status "in-progress" \
  --nextAction "Implement idempotency key rotation for retry logic" \
  --warnings '["Test coverage for webhooks is at 60%, target is 90%"]'

smart-handoff --action "latest" --sessionId "project-x"
```

`smart-handoff:create` is auto-enriched with a full cognition snapshot: recent decisions, confidence levels, active intents, error patterns, and lessons learned.

## 9. Context Budget Manager

```json
context-budget --action "estimate" --sessionId "project-x"
context-budget --action "optimize" --sessionId "project-x"
```

Estimates how much of the context window is used and suggests what to trim.
