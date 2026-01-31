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
 * Cognition Module
 *
 * AI self-awareness infrastructure: decision journal, confidence tracking,
 * mental models, intent tracking, error patterns, self-critique, handoff, context budget.
 */

// Types
export type {
  Decision,
  ConfidenceRecord,
  ConfidenceProfile,
  MentalModel,
  ModelComponent,
  ModelRelationship,
  Intent,
  IntentLevel,
  IntentStatus,
  DriftAlert,
  ErrorPattern,
  ErrorClassification,
  SelfCritique,
  CritiqueScope,
  HandoffReport,
  ContextBudgetItem,
  ContextBudgetEstimate,
} from './types.js';

export { COGNITION_KEYS, COGNITION_TTL } from './types.js';

// Stores
export { DecisionStore, getDecisionStore, resetDecisionStore } from './decision-store.js';
export { ConfidenceStore, getConfidenceStore, resetConfidenceStore } from './confidence-store.js';
export { MentalModelStore, getMentalModelStore, resetMentalModelStore } from './mental-model-store.js';
export { IntentStore, getIntentStore, resetIntentStore } from './intent-store.js';
export { ErrorPatternStore, getErrorPatternStore, resetErrorPatternStore } from './error-pattern-store.js';
export { SelfCritiqueStore, getSelfCritiqueStore, resetSelfCritiqueStore } from './self-critique-store.js';
export { HandoffStore, getHandoffStore, resetHandoffStore } from './handoff-store.js';
export { ContextBudgetManager, getContextBudgetManager, resetContextBudgetManager } from './context-budget-manager.js';
