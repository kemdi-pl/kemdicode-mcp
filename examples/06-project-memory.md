# Project Memory

Persistent memory that survives across sessions. Store conventions, decisions, and context.

## 1. Store architectural decision

```
write-memory --name "auth-strategy" --content "Using JWT with RS256. Access tokens expire in 15min, refresh tokens in 7 days. Stored in httpOnly cookies, not localStorage." --tags '["architecture", "auth", "security"]' --overwrite false --ttlDays 90
```

## 2. Store coding conventions

```
write-memory --name "coding-conventions" --content "- Use barrel exports (index.ts) for each module\n- Zod schemas for all tool inputs\n- Error handling: return null on failure, throw only for validation\n- Redis keys: use KEYS constant objects, never hardcode strings\n- Singleton pattern with get/reset functions for services" --tags '["conventions", "style"]' --overwrite false --ttlDays 365
```

## 3. Read memory before starting work

```
read-memory --name "auth-strategy"
read-memory --name "coding-conventions"
```

## 4. List all memories for context

```
list-memories --limit 50 --includeContent false
list-memories --limit 10 --includeContent true --tag "architecture"
```

## 5. Append to existing memory

```
edit-memory --name "coding-conventions" --appendContent "\n- All new tools must have .describe() on every Zod field"
```

## 6. Tag management

```
edit-memory --name "auth-strategy" --addTags '["jwt", "cookies"]'
edit-memory --name "auth-strategy" --removeTags '["draft"]'
```

## 7. Clean up obsolete memories

```
delete-memory --name "old-db-schema"
```
