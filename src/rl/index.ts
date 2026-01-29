/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * RL (Reinforcement Learning) Module
 *
 * Provides potential-based reward shaping with dopamine signals
 * to guide agent behavior through intrinsic motivation.
 */

// Types
export type {
  AgentState,
  PotentialWeights,
  IntrinsicRewards,
  ShapedReward,
  DopamineSignal,
  DopamineSignalType,
  DopamineTrigger,
  DopamineTriggerConfig,
  RewardHistoryEntry,
  RewardStats,
  DopamineStats,
  WeightLearningConfig,
} from './types.js';

export {
  DEFAULT_POTENTIAL_WEIGHTS,
  DEFAULT_INTRINSIC_REWARDS,
  DOPAMINE_TRIGGERS,
  RL_KEYS,
  GAMMA,
  DEFAULT_WEIGHT_LEARNING_CONFIG,
} from './types.js';

// State tracking
export {
  StateTracker,
  getStateTracker,
  resetStateTracker,
  type StateTrackerConfig,
  type StateUpdate,
} from './state-tracker.js';

// Potential function
export {
  calculatePotential,
  potentialDifference,
  calculateShapedReward,
  normalizeWeights,
  analyzePotential,
  suggestOptimalAction,
} from './potential.js';

// Rewards
export {
  getIntrinsicReward,
  shapeReward,
  RewardTracker,
  getRewardTracker,
  resetRewardTracker,
  type RewardTrackerConfig,
} from './rewards.js';

// Dopamine
export {
  DopamineEmitter,
  getDopamineEmitter,
  resetDopamineEmitter,
  type DopamineEmitterConfig,
} from './dopamine.js';

// Middleware (tool execution integration)
export { recordToolExecution } from './middleware.js';
