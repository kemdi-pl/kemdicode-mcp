# Example 13: The Nine Minds

Nine specialized cognitive agents, each a different mode of thinking. Loaded on-demand, never preloaded.

> **Inspired by [Ouroboros](https://github.com/Q00/ouroboros) by Harry Munro** — a specification-first AI development system that introduced nine cognitive agent modes with Socratic methodology, ontological analysis, and convergence-driven self-improvement loops.

---

## The Nine Minds

| Mind | Mode | Core Question |
|------|------|---------------|
| `socratic` | Interrogative | "What are you assuming?" |
| `ontologist` | Classificatory | "What IS this, really?" |
| `seed-architect` | Crystallizing | "Is this complete and unambiguous?" |
| `evaluator` | Verificatory | "Did we build the right thing?" |
| `contrarian` | Adversarial | "What if the opposite were true?" |
| `hacker` | Lateral | "What constraints are actually real?" |
| `simplifier` | Reductive | "What's the simplest thing that could work?" |
| `researcher` | Evidential | "What evidence do we actually have?" |
| `architect` | Structural | "If we started over, would we build it this way?" |

---

## Using a Single Mind

Any AI-calling tool accepts a Mind as its `agent` parameter:

```
ask-ai --agent socratic --prompt "We should rewrite the auth module in Rust"
```

The Socratic Interviewer will respond **only with questions**:

```
[Assumption] What specific performance problems have you measured in the current auth module?
[Evidence] What is the current latency, and what is the target?
[Assumption] What makes you think the language is the bottleneck rather than the algorithm?
[Perspective] How would the team maintaining this code in 2 years view a language switch?
[Consequence] What is the cost of maintaining two language runtimes in the same project?
```

---

## Composition Patterns with `mind-chain`

The `mind-chain` tool automates Mind-to-Mind handoff — each Mind receives the accumulated output from all previous Minds, so you don't need to manually copy/paste between steps.

### Pattern 1: Dialectical Progression

Question assumptions → identify essence → crystallize specifications.

```
# Automatic: Socratic → Ontologist → Seed Architect + Synthesis
mind-chain --composition dialectical \
  --prompt "We need a caching layer for the API"
```

### Pattern 2: Adversarial Review

Propose → challenge → verify.

```
# Automatic: Architect → Contrarian → Evaluator + Synthesis
mind-chain --composition adversarial \
  --prompt "Design a notification system for @src/services/"
```

### Pattern 3: Evidence-Based Design

Investigate → find shortcuts → simplify.

```
# Automatic: Researcher → Hacker → Simplifier + Synthesis
mind-chain --composition evidence \
  --prompt "What do we know about our API performance? @src/routes/"
```

### Pattern 4: Full Review (6 Minds)

All core perspectives in one call.

```
mind-chain --composition full-review \
  --prompt "Should we rewrite the auth module in Rust?"
# Runs: Socratic → Ontologist → Architect → Contrarian → Evaluator → Simplifier + Synthesis
```

### Pattern 5: Custom Chain

Pick exactly the Minds you need.

```
mind-chain --composition custom \
  --minds '["researcher", "architect", "evaluator"]' \
  --prompt "Audit database schema for @src/models/"
```

### Manual Composition (step-by-step)

You can still compose Minds manually when you need to intervene between steps:

```
# Step 1: Expose assumptions
ask-ai --agent socratic --prompt "We need a caching layer for the API"

# Step 2: (you review and adjust) then pass to Ontologist
ask-ai --agent ontologist --prompt "Given these assumptions: [paste socratic output]. What IS the real problem?"

# Step 3: Crystallize into spec
ask-ai --agent seed-architect --prompt "Given this analysis: [paste ontologist output]. Create an unambiguous specification."
```

---

## Minds with Agent Orchestrate

Launch an autonomous agent loop using a Mind:

```
agent-orchestrate --agent evaluator --task "Verify the payment integration in @src/payments/" --sessionId "sess-123" --maxIterations 8 --enableCognition true
```

The Evaluator will autonomously:
1. Use `find-definition` and `find-references` to understand the code
2. Apply 3-stage verification (correctness, completeness, fitness)
3. Record findings in `decision-journal` and `confidence-tracker`
4. Produce a structured PASS/CONDITIONAL PASS/FAIL verdict

---

## Multi-Mind Consensus

Use `consensus-prompt` with different Minds as board members:

```
consensus-prompt \
  --prompt "Should we migrate from REST to GraphQL?" \
  --boardModels '["o:gpt-4.1", "a:claude-sonnet-4-6", "g:gemini-2.5-pro"]' \
  --ceoModel "a:claude-sonnet-4-6" \
  --agent architect
```

Or use different Minds via sequential `ask-ai` calls to simulate a board where each member thinks differently:

```
# Architect proposes
ask-ai --agent architect --prompt "Should we migrate from REST to GraphQL? @src/api/"

# Contrarian challenges
ask-ai --agent contrarian --prompt "Challenge this: [architect's proposal]"

# Researcher fact-checks
ask-ai --agent researcher --prompt "What evidence supports either position? [both outputs]"

# Simplifier finds the pragmatic path
ask-ai --agent simplifier --prompt "Given all perspectives, what's the simplest path forward? [all outputs]"
```

---

## Mind + Cognition Integration

Each Mind's output integrates with the cognition subsystem:

```
# Socratic questions → become decision preconditions
ask-ai --agent socratic --prompt "Should we add Redis Cluster support?"
decision-journal action=record decision="Redis Cluster" reasoning="[socratic output as preconditions]"

# Evaluator verdicts → update confidence
ask-ai --agent evaluator --prompt "Review the session recovery implementation @src/session/"
confidence-tracker action=record domain="session-recovery" confidence=85 evidence="Evaluator: 3-stage PASS"

# Researcher findings → error patterns
ask-ai --agent researcher --prompt "Investigate intermittent timeout in cluster bus"
error-pattern action=record errorType="cluster-timeout" pattern="[researcher findings]" fix="[recommended investigation]"
```

---

## When to Use Each Mind

| Situation | Mind | Why |
|-----------|------|-----|
| Starting a new feature | `socratic` | Expose hidden assumptions before building |
| Debugging a subtle bug | `ontologist` | Find what the bug IS, not just its symptoms |
| Writing requirements | `seed-architect` | Turn vague ideas into testable specs |
| Code review | `evaluator` | Structured 3-stage verification |
| Architecture decision | `contrarian` | Stress-test the proposal |
| Stuck on a problem | `hacker` | Question which constraints are real |
| Over-engineered solution | `simplifier` | Strip to essentials |
| Making assumptions | `researcher` | Demand evidence |
| Technical debt review | `architect` | Identify structural vs. symptomatic issues |
