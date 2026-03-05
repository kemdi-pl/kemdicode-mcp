# Code Analysis Workflow

Automated code review, refactoring, and testing pipeline.

## 1. Full code review

```
code-review --files "@src/services/payment.ts" --focus "all" --severity "all" --concise false --withDeps true --continueSession false
```

## 2. Security-focused review

```
code-review --files "@src/auth/*.ts" --focus "security" --severity "critical" --concise true --withDeps false --continueSession false
```

## 3. Explain complex code

```
explain-code --files "@src/ai/providers/registry.ts" --depth "deep" --audience "senior"
```

## 4. Find and fix a bug

```
fix-bug --files "@src/kanban/kanban-store.ts" --description "Tasks with blockedBy list are not properly unblocked when blocking task completes"
```

## 5. Refactor for SOLID principles

```
refactor --files "@src/tools/specialized/auto-fix.tool.ts" --goal "solid" --scope "moderate"
```

## 6. Generate tests

```
write-tests --files "@src/mpc/redis-store.ts" --type "both" --coverage "full"
```

## 7. Analyze dependencies

```
analyze-deps --files "@src/ai/client.ts" --depth "deep" --direction "both"
```

## 8. Auto-fix pipeline

```bash
# Dry run first
auto-fix --files "@src/utils/security.ts" --focus "all" --severity "all" --dryRun true

# Apply fixes
auto-fix --files "@src/utils/security.ts" --focus "all" --severity "critical" --dryRun false
```

## 9. Full quality check

```bash
# Type check
check-types --checker "auto" --timeout 120000 --strict false

# Lint
run-lint --linter "auto" --fix false --timeout 120000

# Test
run-tests --framework "auto" --coverage true --timeout 300000 --watch false
```
