# Documentation

## Architecture

- [Architecture Overview](architecture-overview.md) — system layers, tool registry, providers, infrastructure
- [3-Layer Bus Architecture](architecture-3-layer-bus.md) — ClusterBus (L3), DataFlowBus (L2), GlobalEventBus (L1), bridges, signal flow

## Examples

All examples are in the [examples/](../examples/) directory:

| # | Example | Description |
|:-:|:--------|:------------|
| 01 | [Hot Reload Config](../examples/01-hot-reload-config.md) | Switch AI providers at runtime |
| 02 | [Kanban Sprint](../examples/02-kanban-sprint.md) | End-to-end sprint workflow |
| 03 | [Multi-Agent Coordination](../examples/03-multi-agent-coordination.md) | Agent teams with roles |
| 04 | [Multi-LLM Consensus](../examples/04-multi-llm-consensus.md) | CEO-and-Board pattern |
| 05 | [Code Analysis Workflow](../examples/05-code-analysis-workflow.md) | Review, fix, test pipeline |
| 06 | [Project Memory](../examples/06-project-memory.md) | Persistent cross-session memory |
| 07 | [Recursive Tool Invocation](../examples/07-recursive-tool-invocation.md) | Agent self-service tools |
| 08 | [Cluster Bus & Magistrale](../examples/08-cluster-bus-magistrale.md) | Distributed LLM orchestration |
| 09 | [Data Flow Bus](../examples/09-dataflow-bus.md) | 12 typed inter-module channels |
| 10 | [Cognition Deep Dive](../examples/10-cognition-deep-dive.md) | 8 cognition tools in depth |
| 11 | [Session Recovery, MPC & RL](../examples/11-session-recovery-mpc-rl.md) | Recovery, secrets, learning |
| 12 | [Knowledge Graph & Loci](../examples/12-knowledge-graph-loci.md) | Error-to-solution paths |

See also: [Usage Patterns](../examples/patterns.md) — 18 reusable integration patterns.
