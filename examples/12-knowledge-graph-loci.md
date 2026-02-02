# Knowledge Graph & Loci System

Build, query, and traverse a persistent knowledge graph for error resolution, tool sequence optimization, and context recall.

## 1. Query the knowledge graph

```json
graph-query --sessionId "project-x" \
  --type "error" \
  --limit 20 \
  --sortBy "weight" \
  --sortOrder "desc"

graph-query --sessionId "project-x" \
  --type "solution" \
  --limit 10

graph-query --sessionId "project-x" \
  --type "concept" \
  --limit 10
```

## 2. Find path from error to solution

```json
graph-find-path \
  --fromNodeId "error-node-id" \
  --mode "error-to-solution" \
  --maxPaths 5 \
  --maxDepth 5
```

Traverses the graph from an error node through related concepts to find proven solution nodes.

## 3. Loci Recall — walk the memory palace

```json
loci-recall --sessionId "project-x" --walkAll true
```

Resurrects all knowledge graph entries for the session, providing a full context recall after compaction.

## 4. Tool sequence recommendations

```json
sequence-recommend \
  --agentId "backend-dev" \
  --sessionId "project-x" \
  --showPatterns true \
  --showTransitions true
```

Analyzes the agent's historical tool usage and recommends optimal next tools based on learned patterns.

**Example output:**
```
Based on your recent pattern (code-review → fix-bug → ...)
Recommended next: run-tests (85% probability)
Alternative: auto-fix (12% probability)

Top patterns:
1. code-review → fix-bug → run-tests (used 23 times)
2. file-read → explain-code → refactor (used 15 times)
3. git-diff → code-review → git-commit (used 12 times)
```

## 5. Building project knowledge over time

The knowledge graph grows automatically as you work:

```
Day 1: error-pattern records "Cannot connect to Redis" → fix: "Check REDIS_HOST env"
Day 3: Same error occurs → instant match → fix applied in seconds
Day 7: graph-query shows cluster of Redis-related errors → architectural insight
```

Nodes connect to each other forming a web of project knowledge:
- Error → Solution edges (weighted by success rate)
- Error → File edges (where errors occur most)
- Solution → Concept edges (underlying principles)
- Concept → Concept edges (related ideas)
