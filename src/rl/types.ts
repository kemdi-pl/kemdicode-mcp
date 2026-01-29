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
 * RL (Reinforcement Learning) Reward Shaping Type Definitions
 *
 * Types for potential-based reward shaping with dopamine signals
 * to guide agent behavior through intrinsic motivation.
 */

/**
 * Agent state snapshot for reward calculation
 */
export interface AgentState {
  /** Agent ID */
  agentId: string;
  /** Timestamp of state capture */
  timestamp: number;
  /** Task completion progress (0-1) */
  taskProgress: number;
  /** Historical tool success rate (0-1) */
  toolSuccessRate: number;
  /** Number of peer interactions in session */
  peerInteractions: number;
  /** Total error count in session */
  errorCount: number;
  /** Consecutive errors (resets on success) */
  consecutiveErrors: number;
  /** Age of current state in ms */
  stateAge: number;
  /** Current tool being used */
  currentTool?: string;
  /** Current task description */
  currentTask?: string;
  /** Session ID */
  sessionId: string;
  /** Total tool calls in session */
  totalToolCalls: number;
  /** Successful tool calls in session */
  successfulToolCalls: number;
}

/**
 * Weights for potential function calculation
 */
export interface PotentialWeights {
  /** Weight for task progress (positive) */
  taskProgress: number;
  /** Weight for tool success rate (positive) */
  toolSuccessRate: number;
  /** Weight for peer interactions (positive) */
  peerInteractions: number;
  /** Penalty weight for errors (positive = penalty) */
  errorPenalty: number;
  /** Extra penalty for consecutive errors */
  consecutiveErrorPenalty: number;
  /** Time decay factor */
  ageDecay: number;
}

/**
 * Default potential weights
 */
export const DEFAULT_POTENTIAL_WEIGHTS: PotentialWeights = {
  taskProgress: 10.0,
  toolSuccessRate: 5.0,
  peerInteractions: 2.0,
  errorPenalty: 3.0,
  consecutiveErrorPenalty: 5.0,
  ageDecay: 0.001,
};

/**
 * Intrinsic reward values for different events
 */
export interface IntrinsicRewards {
  /** Successful tool execution */
  TOOL_SUCCESS: number;
  /** Tool execution failure */
  TOOL_FAILURE: number;
  /** Fast tool success (< 1s) */
  TOOL_FAST_SUCCESS: number;
  /** Pattern/insight discovered */
  PATTERN_DISCOVERED: number;
  /** Task completed */
  TASK_COMPLETED: number;
  /** Effective peer collaboration */
  PEER_COLLABORATION: number;
  /** Repeated same error */
  REPEATED_ERROR: number;
  /** Novel solution found */
  NOVEL_SOLUTION: number;
}

/**
 * Default intrinsic reward values
 */
export const DEFAULT_INTRINSIC_REWARDS: IntrinsicRewards = {
  TOOL_SUCCESS: 1.0,
  TOOL_FAILURE: -0.5,
  TOOL_FAST_SUCCESS: 1.5,
  PATTERN_DISCOVERED: 3.0,
  TASK_COMPLETED: 5.0,
  PEER_COLLABORATION: 2.0,
  REPEATED_ERROR: -2.0,
  NOVEL_SOLUTION: 4.0,
};

/**
 * Shaped reward calculation result
 */
export interface ShapedReward {
  /** Original intrinsic reward */
  intrinsicReward: number;
  /** Potential of previous state */
  previousPotential: number;
  /** Potential of current state */
  currentPotential: number;
  /** Discount factor gamma */
  gamma: number;
  /** Final shaped reward: r + γ*Φ(s') - Φ(s) */
  shapedReward: number;
  /** Timestamp */
  timestamp: number;
  /** Associated tool/action */
  action?: string;
  /** Agent ID */
  agentId: string;
}

/**
 * Dopamine signal types
 */
export type DopamineSignalType = 'spike' | 'dip' | 'sustained' | 'baseline';

/**
 * Dopamine signal for immediate feedback
 */
export interface DopamineSignal {
  /** Signal ID */
  id: string;
  /** Agent receiving the signal */
  agentId: string;
  /** Signal type */
  type: DopamineSignalType;
  /** Signal intensity (-1 to 1) */
  intensity: number;
  /** Trigger event */
  trigger: DopamineTrigger;
  /** Timestamp */
  timestamp: number;
  /** Duration in ms (for sustained signals) */
  duration?: number;
  /** Associated action/tool */
  action?: string;
  /** Human-readable message */
  message?: string;
}

/**
 * Events that trigger dopamine signals
 */
export type DopamineTrigger =
  | 'tool_success'
  | 'tool_fast_success'
  | 'tool_failure'
  | 'pattern_discovered'
  | 'task_completed'
  | 'task_started'
  | 'repeated_error'
  | 'novel_solution'
  | 'collaboration_success'
  | 'stagnation_detected'
  | 'breakthrough';

/**
 * Dopamine trigger configuration
 */
export interface DopamineTriggerConfig {
  trigger: DopamineTrigger;
  signalType: DopamineSignalType;
  baseIntensity: number;
  message: string;
}

/**
 * Default dopamine trigger configurations
 */
export const DOPAMINE_TRIGGERS: Record<DopamineTrigger, DopamineTriggerConfig> = {
  tool_success: {
    trigger: 'tool_success',
    signalType: 'spike',
    baseIntensity: 0.3,
    message: 'Tool executed successfully',
  },
  tool_fast_success: {
    trigger: 'tool_fast_success',
    signalType: 'spike',
    baseIntensity: 0.5,
    message: 'Rapid successful execution!',
  },
  tool_failure: {
    trigger: 'tool_failure',
    signalType: 'dip',
    baseIntensity: -0.4,
    message: 'Tool execution failed',
  },
  pattern_discovered: {
    trigger: 'pattern_discovered',
    signalType: 'spike',
    baseIntensity: 0.7,
    message: 'New pattern identified!',
  },
  task_completed: {
    trigger: 'task_completed',
    signalType: 'spike',
    baseIntensity: 1.0,
    message: 'Task completed successfully!',
  },
  task_started: {
    trigger: 'task_started',
    signalType: 'sustained',
    baseIntensity: 0.2,
    message: 'New task initiated',
  },
  repeated_error: {
    trigger: 'repeated_error',
    signalType: 'dip',
    baseIntensity: -0.8,
    message: 'Repeated error detected',
  },
  novel_solution: {
    trigger: 'novel_solution',
    signalType: 'spike',
    baseIntensity: 0.9,
    message: 'Novel solution discovered!',
  },
  collaboration_success: {
    trigger: 'collaboration_success',
    signalType: 'spike',
    baseIntensity: 0.6,
    message: 'Successful collaboration',
  },
  stagnation_detected: {
    trigger: 'stagnation_detected',
    signalType: 'dip',
    baseIntensity: -0.3,
    message: 'Progress stagnation detected',
  },
  breakthrough: {
    trigger: 'breakthrough',
    signalType: 'spike',
    baseIntensity: 1.0,
    message: 'Breakthrough achieved!',
  },
};

/**
 * Reward history entry for persistence
 */
export interface RewardHistoryEntry {
  /** Entry ID */
  id: string;
  /** Shaped reward data */
  reward: ShapedReward;
  /** Pre-action state */
  preState: AgentState;
  /** Post-action state */
  postState: AgentState;
  /** Action that triggered reward */
  action: string;
  /** Session ID */
  sessionId: string;
}

/**
 * Aggregated reward statistics
 */
export interface RewardStats {
  /** Agent ID */
  agentId: string;
  /** Session ID */
  sessionId: string;
  /** Total rewards received */
  totalRewards: number;
  /** Average shaped reward */
  averageReward: number;
  /** Max reward achieved */
  maxReward: number;
  /** Min reward (can be negative) */
  minReward: number;
  /** Cumulative reward sum */
  cumulativeReward: number;
  /** Number of reward events */
  rewardCount: number;
  /** Rewards per tool */
  rewardsByTool: Record<string, { count: number; total: number; average: number }>;
  /** Recent trend (last 10 vs previous 10) */
  recentTrend: 'improving' | 'declining' | 'stable';
  /** Time range */
  timeRange: { start: number; end: number };
}

/**
 * Dopamine log statistics
 */
export interface DopamineStats {
  /** Agent ID */
  agentId: string;
  /** Total signals */
  totalSignals: number;
  /** Signals by type */
  byType: Record<DopamineSignalType, number>;
  /** Signals by trigger */
  byTrigger: Record<DopamineTrigger, number>;
  /** Average intensity */
  averageIntensity: number;
  /** Recent signals (last N) */
  recentSignals: DopamineSignal[];
}

/**
 * Redis key patterns for RL
 */
export const RL_KEYS = {
  /** Agent state: rl:state:{agentId} */
  state: (agentId: string) => `rl:state:${agentId}`,

  /** State history: rl:state_history:{agentId} */
  stateHistory: (agentId: string) => `rl:state_history:${agentId}`,

  /** Rewards: rl:rewards:{agentId} */
  rewards: (agentId: string) => `rl:rewards:${agentId}`,

  /** Dopamine signals: rl:dopamine:{agentId} */
  dopamine: (agentId: string) => `rl:dopamine:${agentId}`,

  /** Running stats: rl:stats:{agentId}:running */
  runningStats: (agentId: string) => `rl:stats:${agentId}:running`,

  /** Tool performance: rl:tools:{agentId} */
  toolPerformance: (agentId: string) => `rl:tools:${agentId}`,

  /** Session rewards: rl:session:{sessionId}:rewards */
  sessionRewards: (sessionId: string) => `rl:session:${sessionId}:rewards`,
} as const;

/**
 * Discount factor (gamma) for reward shaping
 */
export const GAMMA = 0.95;

/**
 * Configuration for adaptive weight learning
 */
export interface WeightLearningConfig {
  /** Learning rate for weight updates */
  learningRate: number;
  /** Minimum weight value */
  minWeight: number;
  /** Maximum weight value */
  maxWeight: number;
  /** How often to update weights (in episodes) */
  updateInterval: number;
}

/**
 * Default weight learning configuration
 */
export const DEFAULT_WEIGHT_LEARNING_CONFIG: WeightLearningConfig = {
  learningRate: 0.01,
  minWeight: 0.1,
  maxWeight: 20.0,
  updateInterval: 10,
};
