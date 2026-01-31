/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Cognition Module Type Definitions
 *
 * Types for AI self-awareness infrastructure:
 * - Decision Journal: WHY choices were made
 * - Confidence Tracker: self-assessed certainty
 * - Mental Model Store: persistent system understanding
 * - Intent Tracker: human goal hierarchy & drift detection
 * - Error Pattern DB: cross-session mistake learning
 * - Self-Critique Log: post-session reflection
 * - Smart Handoff: structured context transfer
 * - Context Budget Manager: relevance-based eviction
 */

// ─────────────────────────────────────────────────────────────────────────────
// Decision Journal
// ─────────────────────────────────────────────────────────────────────────────

export interface Decision {
  id: string;
  sessionId: string;
  agentId: string;
  timestamp: number;
  /** What decision was being made */
  question: string;
  /** What was chosen */
  chosen: string;
  /** What else was considered */
  alternatives: string[];
  /** Why this choice (the core value) */
  reasoning: string;
  /** Self-assessed confidence 0-1 */
  confidence: number;
  /** Surrounding context that informed the decision */
  context: string;
  /** What actually happened (filled later) */
  outcome?: string;
  /** Tags for categorization */
  tags: string[];
  /** Link to knowledge graph node */
  graphNodeId?: string;
  /** Related file paths */
  relatedFiles?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence Tracker
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfidenceRecord {
  id: string;
  sessionId: string;
  agentId: string;
  timestamp: number;
  /** Tool or action being assessed */
  toolName: string;
  /** Self-assessed confidence 0-1 */
  confidence: number;
  /** Domain/area of the assessment */
  domain: string;
  /** Optional reasoning for the confidence level */
  reasoning?: string;
  /** Whether this was flagged for human review */
  flaggedForReview: boolean;
  /** Post-hoc outcome assessment */
  outcome?: 'correct' | 'incorrect' | 'partial' | 'unknown';
}

export interface ConfidenceProfile {
  agentId: string;
  /** Average confidence per domain */
  domainScores: Record<string, { avg: number; count: number; correctRate: number }>;
  /** How well confidence predicts actual outcomes (0=uncalibrated, 1=perfect) */
  calibration: number;
  /** Percentage of actions with confidence < 0.5 */
  lowConfidenceRate: number;
  /** Total records analyzed */
  totalRecords: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mental Model Store
// ─────────────────────────────────────────────────────────────────────────────

export interface MentalModel {
  id: string;
  sessionId: string;
  /** Name of the model (e.g., "KemdiCode MCP Architecture") */
  name: string;
  /** High-level description */
  description: string;
  /** Components in the model */
  components: ModelComponent[];
  /** Relationships between components */
  relationships: ModelRelationship[];
  createdAt: number;
  updatedAt: number;
  /** When underlying files changed (undefined = fresh) */
  staleSince?: number;
  /** Tags */
  tags: string[];
}

export interface ModelComponent {
  /** Component name (unique within model) */
  name: string;
  /** What this component is responsible for */
  role: string;
  /** Source files that implement this component */
  files: string[];
  /** Other component names this depends on */
  dependencies: string[];
  /** Key rules, constraints, invariants */
  invariants: string[];
}

export interface ModelRelationship {
  from: string;
  to: string;
  /** Relationship type */
  type: 'calls' | 'depends-on' | 'produces' | 'consumes' | 'extends' | 'contains';
  /** How they communicate (e.g., "Redis Pub/Sub", "direct import") */
  protocol?: string;
  /** Human-readable description */
  description?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent Tracker
// ─────────────────────────────────────────────────────────────────────────────

export type IntentLevel = 'mission' | 'goal' | 'sub-goal' | 'task';
export type IntentStatus = 'active' | 'completed' | 'abandoned' | 'drifted';

export interface Intent {
  id: string;
  sessionId: string;
  agentId: string;
  timestamp: number;
  /** Hierarchy level */
  level: IntentLevel;
  /** What the human/agent wants to achieve */
  description: string;
  /** Parent intent ID (for sub-goals/tasks) */
  parentIntentId?: string;
  /** Current status */
  status: IntentStatus;
  /** Drift alerts triggered */
  driftAlerts: DriftAlert[];
  /** Completion timestamp */
  completedAt?: number;
  /** Tags */
  tags: string[];
}

export interface DriftAlert {
  timestamp: number;
  /** What the agent was doing when drift was detected */
  currentAction: string;
  /** What the agent should have been doing */
  expectedDirection: string;
  /** 0 = on track, 1 = completely off */
  driftScore: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Pattern DB
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorClassification =
  | 'type-error'
  | 'reference-error'
  | 'file-not-found'
  | 'permission'
  | 'timeout'
  | 'logic-error'
  | 'syntax-error'
  | 'dependency'
  | 'config'
  | 'network'
  | 'unknown';

export interface ErrorPattern {
  id: string;
  /** Error classification */
  errorType: ErrorClassification;
  /** When does this error happen? */
  context: string;
  /** What does it look like? */
  symptoms: string[];
  /** Root cause explanation */
  rootCause: string;
  /** What fixed it */
  fix: string;
  /** Times this pattern was observed */
  occurrences: number;
  /** Last time this was seen */
  lastSeen: number;
  /** Sessions where this occurred */
  sessionIds: string[];
  /** Tools involved */
  toolNames: string[];
  /** Tags */
  tags: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-Critique Log
// ─────────────────────────────────────────────────────────────────────────────

export type CritiqueScope = 'session' | 'task' | 'decision';

export interface SelfCritique {
  id: string;
  sessionId: string;
  agentId: string;
  timestamp: number;
  /** What is being critiqued */
  scope: CritiqueScope;
  /** ID of the session/task/decision being reviewed */
  targetId?: string;
  /** What went well */
  wentWell: string[];
  /** What went poorly */
  wentPoorly: string[];
  /** What would be done differently */
  wouldChange: string[];
  /** Extracted lessons */
  lessonsLearned: string[];
  /** Self-assessed efficiency 0-1 */
  efficiency: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart Handoff
// ─────────────────────────────────────────────────────────────────────────────

export interface HandoffReport {
  id: string;
  sessionId: string;
  agentId: string;
  timestamp: number;
  /** The human's original intent */
  intent: string;
  /** The approach that was taken */
  approach: string;
  /** Why this approach was chosen */
  reasoning: string;
  /** What's done */
  completed: string[];
  /** What's in progress */
  inProgress: string[];
  /** What's blocked and why */
  blocked: string[];
  /** Known unknowns — things we know we don't know */
  knownUnknowns: string[];
  /** Warnings for next agent */
  warnings: string[];
  /** The single most important first action for the next agent */
  firstAction: string;
  /** Confidence in the overall state 0-1 */
  confidence: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Budget Manager
// ─────────────────────────────────────────────────────────────────────────────

export interface ContextBudgetItem {
  /** Item identifier */
  id: string;
  /** Category: decision, model, intent, fact, file, error, pattern */
  category: string;
  /** Human-readable summary */
  summary: string;
  /** Relevance to current goal 0-1 */
  relevance: number;
  /** Age in milliseconds */
  ageMs: number;
  /** How many times accessed */
  accessCount: number;
  /** Estimated token cost */
  estimatedTokens: number;
}

export interface ContextBudgetEstimate {
  totalItems: number;
  totalEstimatedTokens: number;
  byCategory: Record<string, { count: number; tokens: number }>;
  /** Items ranked by relevance (most relevant first) */
  relevanceRanking: ContextBudgetItem[];
  /** Items suggested for eviction (least relevant) */
  suggestedEvictions: ContextBudgetItem[];
  /** How well current context aligns with goal 0-1 */
  goalAlignment: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Redis Key Patterns
// ─────────────────────────────────────────────────────────────────────────────

export const COGNITION_KEYS = {
  // Decision Journal
  decision: (id: string) => `mcp:cognition:decision:${id}`,
  decisionsBySession: (sessionId: string) => `mcp:cognition:decisions:session:${sessionId}`,
  decisionsByAgent: (agentId: string) => `mcp:cognition:decisions:agent:${agentId}`,

  // Confidence Tracker
  confidence: (id: string) => `mcp:cognition:confidence:${id}`,
  confidenceBySession: (sessionId: string) => `mcp:cognition:confidence:session:${sessionId}`,
  confidenceProfile: (agentId: string) => `mcp:cognition:confidence:profile:${agentId}`,
  confidenceReviewQueue: () => `mcp:cognition:confidence:review-queue`,

  // Mental Model Store
  model: (id: string) => `mcp:cognition:model:${id}`,
  modelsBySession: (sessionId: string) => `mcp:cognition:models:session:${sessionId}`,
  modelByName: (name: string) => `mcp:cognition:model:name:${name.toLowerCase().replace(/\s+/g, '-')}`,

  // Intent Tracker
  intent: (id: string) => `mcp:cognition:intent:${id}`,
  intentsBySession: (sessionId: string) => `mcp:cognition:intents:session:${sessionId}`,
  activeIntent: (sessionId: string) => `mcp:cognition:intent:active:${sessionId}`,

  // Error Pattern DB
  errorPattern: (id: string) => `mcp:cognition:error-pattern:${id}`,
  errorPatternsByType: (errorType: string) => `mcp:cognition:error-patterns:type:${errorType}`,
  errorPatternsAll: () => `mcp:cognition:error-patterns:all`,

  // Self-Critique Log
  critique: (id: string) => `mcp:cognition:critique:${id}`,
  critiquesBySession: (sessionId: string) => `mcp:cognition:critiques:session:${sessionId}`,

  // Smart Handoff
  handoff: (id: string) => `mcp:cognition:handoff:${id}`,
  handoffBySession: (sessionId: string) => `mcp:cognition:handoff:session:${sessionId}`,
  latestHandoff: (sessionId: string) => `mcp:cognition:handoff:latest:${sessionId}`,

  // Context Budget
  budgetSnapshot: (sessionId: string) => `mcp:cognition:budget:snapshot:${sessionId}`,
} as const;

/** Default TTLs in seconds */
export const COGNITION_TTL = {
  /** Decisions: 30 days */
  decision: 2592000,
  /** Confidence records: 7 days */
  confidence: 604800,
  /** Confidence profiles: 30 days */
  confidenceProfile: 2592000,
  /** Mental models: 30 days */
  model: 2592000,
  /** Intents: 7 days */
  intent: 604800,
  /** Error patterns: permanent (no TTL) */
  errorPattern: 0,
  /** Self-critiques: 30 days */
  critique: 2592000,
  /** Handoff reports: 30 days */
  handoff: 2592000,
  /** Budget snapshots: 1 day */
  budget: 86400,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Cognition Event Bus
// ─────────────────────────────────────────────────────────────────────────────

export type CognitionEventType =
  | 'decision:recorded'
  | 'confidence:recorded'
  | 'confidence:low'
  | 'confidence:outcome-updated'
  | 'error:recorded'
  | 'error:matched'
  | 'error:occurrence'
  | 'critique:recorded'
  | 'critique:lesson-learned'
  | 'intent:set'
  | 'intent:drifted'
  | 'handoff:created'
  | 'model:created'
  | 'model:stale'
  | 'model:updated';

export interface CognitionEvent<T = unknown> {
  type: CognitionEventType;
  timestamp: number;
  sessionId: string;
  agentId?: string;
  /** The ID of the source record that triggered this event */
  sourceId: string;
  /** The type of the source record */
  sourceType: string;
  /** Arbitrary payload specific to the event type */
  payload: T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-Link Types
// ─────────────────────────────────────────────────────────────────────────────

export type CognitionRecordType =
  | 'decision'
  | 'confidence'
  | 'error-pattern'
  | 'intent'
  | 'critique'
  | 'handoff'
  | 'model';

export interface CognitionLink {
  sourceType: CognitionRecordType;
  sourceId: string;
  targetType: CognitionRecordType;
  targetId: string;
  /** Why this link exists */
  reason: string;
  createdAt: number;
}

export const COGNITION_LINK_KEYS = {
  /** Forward links from a record */
  links: (sourceType: string, sourceId: string) =>
    `mcp:cognition:links:${sourceType}:${sourceId}`,
  /** Reverse links to a record */
  backlinks: (targetType: string, targetId: string) =>
    `mcp:cognition:backlinks:${targetType}:${targetId}`,
  /** Link detail */
  detail: (srcType: string, srcId: string, tgtType: string, tgtId: string) =>
    `mcp:cognition:link-detail:${srcType}:${srcId}:${tgtType}:${tgtId}`,
} as const;
