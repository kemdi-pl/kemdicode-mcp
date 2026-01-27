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
 * RL Potential Function
 *
 * Calculates the potential value Φ(s) for reward shaping.
 * The shaped reward is: R_shaped = r + γ * Φ(s') - Φ(s)
 */

import type { AgentState, PotentialWeights } from './types.js';
import { DEFAULT_POTENTIAL_WEIGHTS, GAMMA } from './types.js';

/**
 * Calculate the potential value for a given state
 *
 * Φ(s) = W.taskProgress * s.taskProgress
 *      + W.toolSuccessRate * s.toolSuccessRate
 *      + W.peerInteractions * s.peerInteractions
 *      - W.errorPenalty * s.errorCount
 *      - W.consecutiveErrorPenalty * s.consecutiveErrors
 *      - W.ageDecay * (s.stateAge / 1000)
 */
export function calculatePotential(
  state: AgentState,
  weights: PotentialWeights = DEFAULT_POTENTIAL_WEIGHTS
): number {
  const positive =
    weights.taskProgress * state.taskProgress +
    weights.toolSuccessRate * state.toolSuccessRate +
    weights.peerInteractions * Math.min(state.peerInteractions, 10) * 0.1; // Cap peer interactions contribution

  const negative =
    weights.errorPenalty * state.errorCount +
    weights.consecutiveErrorPenalty * state.consecutiveErrors * state.consecutiveErrors + // Quadratic penalty
    weights.ageDecay * (state.stateAge / 1000);

  return positive - negative;
}

/**
 * Calculate the potential difference between two states
 */
export function potentialDifference(
  previousState: AgentState,
  currentState: AgentState,
  weights: PotentialWeights = DEFAULT_POTENTIAL_WEIGHTS
): number {
  const previousPotential = calculatePotential(previousState, weights);
  const currentPotential = calculatePotential(currentState, weights);

  // γ * Φ(s') - Φ(s)
  return GAMMA * currentPotential - previousPotential;
}

/**
 * Calculate shaped reward from intrinsic reward and state transition
 */
export function calculateShapedReward(
  intrinsicReward: number,
  previousState: AgentState,
  currentState: AgentState,
  weights: PotentialWeights = DEFAULT_POTENTIAL_WEIGHTS
): {
  shapedReward: number;
  intrinsicReward: number;
  previousPotential: number;
  currentPotential: number;
  potentialDiff: number;
} {
  const previousPotential = calculatePotential(previousState, weights);
  const currentPotential = calculatePotential(currentState, weights);
  const potentialDiff = GAMMA * currentPotential - previousPotential;
  const shapedReward = intrinsicReward + potentialDiff;

  return {
    shapedReward,
    intrinsicReward,
    previousPotential,
    currentPotential,
    potentialDiff,
  };
}

/**
 * Normalize potential weights
 */
export function normalizeWeights(weights: PotentialWeights): PotentialWeights {
  const total =
    weights.taskProgress +
    weights.toolSuccessRate +
    weights.peerInteractions +
    weights.errorPenalty +
    weights.consecutiveErrorPenalty +
    weights.ageDecay;

  if (total === 0) return DEFAULT_POTENTIAL_WEIGHTS;

  return {
    taskProgress: weights.taskProgress / total,
    toolSuccessRate: weights.toolSuccessRate / total,
    peerInteractions: weights.peerInteractions / total,
    errorPenalty: weights.errorPenalty / total,
    consecutiveErrorPenalty: weights.consecutiveErrorPenalty / total,
    ageDecay: weights.ageDecay / total,
  };
}

/**
 * Analyze potential breakdown for debugging
 */
export function analyzePotential(
  state: AgentState,
  weights: PotentialWeights = DEFAULT_POTENTIAL_WEIGHTS
): {
  total: number;
  components: {
    taskProgress: number;
    toolSuccessRate: number;
    peerInteractions: number;
    errorPenalty: number;
    consecutiveErrorPenalty: number;
    ageDecay: number;
  };
} {
  const taskProgressContrib = weights.taskProgress * state.taskProgress;
  const toolSuccessContrib = weights.toolSuccessRate * state.toolSuccessRate;
  const peerContrib = weights.peerInteractions * Math.min(state.peerInteractions, 10) * 0.1;
  const errorPenaltyContrib = -weights.errorPenalty * state.errorCount;
  const consecutiveErrorContrib =
    -weights.consecutiveErrorPenalty * state.consecutiveErrors * state.consecutiveErrors;
  const ageDecayContrib = -weights.ageDecay * (state.stateAge / 1000);

  return {
    total:
      taskProgressContrib +
      toolSuccessContrib +
      peerContrib +
      errorPenaltyContrib +
      consecutiveErrorContrib +
      ageDecayContrib,
    components: {
      taskProgress: taskProgressContrib,
      toolSuccessRate: toolSuccessContrib,
      peerInteractions: peerContrib,
      errorPenalty: errorPenaltyContrib,
      consecutiveErrorPenalty: consecutiveErrorContrib,
      ageDecay: ageDecayContrib,
    },
  };
}

/**
 * Estimate optimal action based on potential gain
 *
 * Given the current state, estimate which action type would
 * maximize the potential function.
 */
export function suggestOptimalAction(state: AgentState): {
  suggestion: string;
  reason: string;
} {
  // If task progress is low, focus on completing tasks
  if (state.taskProgress < 0.5) {
    return {
      suggestion: 'focus_on_task',
      reason: 'Task progress is below 50%. Focus on completing current task.',
    };
  }

  // If success rate is dropping, slow down
  if (state.toolSuccessRate < 0.7) {
    return {
      suggestion: 'improve_accuracy',
      reason: 'Tool success rate is low. Take more care with tool usage.',
    };
  }

  // If consecutive errors, change approach
  if (state.consecutiveErrors >= 2) {
    return {
      suggestion: 'change_approach',
      reason: 'Multiple consecutive errors. Try a different approach.',
    };
  }

  // If isolated, collaborate
  if (state.peerInteractions < 2 && state.totalToolCalls > 10) {
    return {
      suggestion: 'collaborate',
      reason: 'Low peer interactions. Consider sharing context or asking for help.',
    };
  }

  // Default: continue current approach
  return {
    suggestion: 'continue',
    reason: 'Current approach is working. Keep going.',
  };
}
