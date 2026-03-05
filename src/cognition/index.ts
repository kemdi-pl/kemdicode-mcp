/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
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

export { COGNITION_KEYS, COGNITION_TTL, COGNITION_LINK_KEYS } from './types.js';

export type {
  CognitionEvent,
  CognitionEventType,
  CognitionRecordType,
  CognitionLink,
} from './types.js';

// Stores
export { DecisionStore, getDecisionStore, resetDecisionStore } from './decision-store.js';
export { ConfidenceStore, getConfidenceStore, resetConfidenceStore } from './confidence-store.js';
export { MentalModelStore, getMentalModelStore, resetMentalModelStore } from './mental-model-store.js';
export { IntentStore, getIntentStore, resetIntentStore } from './intent-store.js';
export { ErrorPatternStore, getErrorPatternStore, resetErrorPatternStore } from './error-pattern-store.js';
export { SelfCritiqueStore, getSelfCritiqueStore, resetSelfCritiqueStore } from './self-critique-store.js';
export { HandoffStore, getHandoffStore, resetHandoffStore } from './handoff-store.js';
export { ContextBudgetManager, getContextBudgetManager, resetContextBudgetManager } from './context-budget-manager.js';

// Event Bus
export { CognitionEventBus, getCognitionEventBus, resetCognitionEventBus } from './event-bus.js';

// Cross-Linker
export { CognitionCrossLinker, getCrossLinker, resetCrossLinker } from './cross-linker.js';

// Event Handlers
export { initCognitionEventHandlers } from './event-handlers.js';

// CTC Math (Closed Timelike Curve inspired algorithms)
export {
  CTC,
  findCausalPast,
  transitiveReduction,
  findCausalCore,
  tokenizeForEntropy,
  textToDistribution,
  shannonEntropy,
  jensenShannonDivergence,
  mutualInformationApprox,
  informationDensity,
  tfidfCosineSimilarity,
  findFixedPoint,
  compactThinkingChain,
  gravitationalTtl,
  itemKey,
  perturbationImpact,
  rankByPerturbationImpact,
} from './ctc-math.js';

export type {
  CognitionItemRef,
  CausalEdge,
  CausalCoreOutput,
  FixedPointResult,
  ChainCompactionOutput,
} from './ctc-math.js';

export type {
  CausalCoreResult,
  ConsistencyViolation,
  ChainCompactionResult,
} from './types.js';

// Phase Detector (Poincaré sections — v3.0.0 Lorenz)
export {
  PHASE,
  computeConsecutiveJSD,
  detectPhaseBoundaries,
  extractPhaseSegments,
  analyzePhases,
} from './phase-detector.js';

export type {
  PhaseBoundary,
  PhaseSegment,
  PhaseAnalysis,
} from './phase-detector.js';

// Orbit Compressor (Lorenz attractor pattern detection — v3.0.0)
export {
  ORBIT,
  computeSimilarityMatrix,
  detectCycleRepetitions,
  findOrbitalCycles,
  analyzeOrbits,
} from './orbit-compressor.js';

export type {
  OrbitalCycle,
  OrbitAnalysis,
} from './orbit-compressor.js';
