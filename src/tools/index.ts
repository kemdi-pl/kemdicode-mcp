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

import { registerTool } from './registry.js';
import { askAITool } from './ask-ai.tool.js';
import { pingTool, helpTool, planTool, buildTool } from './simple-tools.js';
import { brainstormTool } from './brainstorm.tool.js';
import { timeoutTestTool } from './timeout-test.tool.js';
import { batchTool } from './batch.tool.js';
import {
  codeReviewTool,
  writeTestsTool,
  explainCodeTool,
  fixBugTool,
  refactorTool,
  autoFixTool,
  autoFixAgentTool,
  analyzeDepsTool,
} from './specialized/index.js';
import { getSharedContextTool, feedbackTool, sharedThoughtsTool } from './context/index.js';
import {
  agentListTool,
  agentRegisterTool,
  agentWatchTool,
  agentAlertTool,
  agentInjectTool,
  agentHistoryTool,
  monitorTool,
  agentSummaryTool,
  queueMessageTool,
} from './agents/index.js';
import {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitBlameTool,
  gitBranchTool,
} from './git/index.js';
import {
  fileReadTool,
  fileWriteTool,
  fileSearchTool,
  fileTreeTool,
  fileDiffTool,
} from './file/index.js';
import {
  findDefinitionTool,
  findReferencesTool,
  findSymbolsTool,
  semanticSearchTool,
  codeOutlineTool,
  insertBeforeSymbolTool,
  insertAfterSymbolTool,
  renameSymbolTool,
} from './code/index.js';
import {
  projectInfoTool,
  runScriptTool,
  checkTypesTool,
  runLintTool,
  runTestsTool,
} from './project/index.js';
import {
  shellExecTool,
  processListTool,
  envInfoTool,
  memoryUsageTool,
  configTool,
} from './system/index.js';
import { mpcSplitTool, mpcDistributeTool, mpcReconstructTool, mpcStatusTool } from './mpc/index.js';
import { rlRewardStatsTool, rlDopamineLogTool } from './rl/index.js';
import {
  graphQueryTool,
  graphFindPathTool,
  lociRecallTool,
  sequenceRecommendTool,
} from './loci/index.js';
import {
  insertAtLineTool,
  deleteLinesTool,
  replaceLinesTool,
  replaceContentTool,
} from './edit/index.js';
import {
  writeMemoryTool,
  readMemoryTool,
  listMemoriesTool,
  deleteMemoryTool,
  editMemoryTool,
} from './memory/index.js';
import {
  taskCreateTool,
  taskListTool,
  taskClaimTool,
  taskAssignTool,
  taskUpdateTool,
  boardStatusTool,
  taskPushMultiTool,
  workspaceCreateTool,
  workspaceListTool,
  workspaceJoinTool,
  workspaceLeaveTool,
  boardCreateTool,
  boardListTool,
  boardShareTool,
  boardMembersTool,
  boardInviteTool,
} from './kanban/index.js';
import { aiConfigTool } from './system/ai-config.tool.js';
import { aiModelsTool } from './system/ai-models.tool.js';
import { invokeToolTool, invokeBatchTool, invocationLogTool } from './recursive/index.js';
import { multiPromptTool, consensusPromptTool } from './multi-llm/index.js';
import {
  sessionListTool,
  sessionInfoTool,
  sessionCreateTool,
  sessionSwitchTool,
  sessionDeleteTool,
} from './session/index.js';

// Core tools
registerTool(askAITool);
registerTool(planTool);
registerTool(buildTool);
registerTool(brainstormTool);
registerTool(batchTool); // Multi-operation parallel execution

// Specialized analysis tools
registerTool(codeReviewTool);
registerTool(writeTestsTool);
registerTool(explainCodeTool);
registerTool(fixBugTool);
registerTool(refactorTool);
registerTool(autoFixTool);
registerTool(autoFixAgentTool);
registerTool(analyzeDepsTool);

// Context sharing & Learning
registerTool(getSharedContextTool);
registerTool(feedbackTool);
registerTool(sharedThoughtsTool);

// Agent monitoring & supervision tools
registerTool(agentListTool);
registerTool(agentRegisterTool);
registerTool(agentWatchTool);
registerTool(agentAlertTool);
registerTool(agentInjectTool);
registerTool(agentHistoryTool);
registerTool(monitorTool);
registerTool(agentSummaryTool);
registerTool(queueMessageTool);

// Git operation tools
registerTool(gitStatusTool);
registerTool(gitDiffTool);
registerTool(gitLogTool);
registerTool(gitBlameTool);
registerTool(gitBranchTool);

// File operation tools
registerTool(fileReadTool);
registerTool(fileWriteTool);
registerTool(fileSearchTool);
registerTool(fileTreeTool);
registerTool(fileDiffTool);

// Code intelligence tools
registerTool(findDefinitionTool);
registerTool(findReferencesTool);
registerTool(findSymbolsTool);
registerTool(semanticSearchTool);
registerTool(codeOutlineTool);

// Symbol editing tools
registerTool(insertBeforeSymbolTool);
registerTool(insertAfterSymbolTool);
registerTool(renameSymbolTool);

// Project management tools
registerTool(projectInfoTool);
registerTool(runScriptTool);
registerTool(checkTypesTool);
registerTool(runLintTool);
registerTool(runTestsTool);

// System tools
registerTool(shellExecTool);
registerTool(processListTool);
registerTool(envInfoTool);
registerTool(memoryUsageTool);
registerTool(configTool);

// Utility tools
registerTool(pingTool);
registerTool(helpTool);
registerTool(timeoutTestTool);

// MPC (Multi-Party Computation) tools
registerTool(mpcSplitTool);
registerTool(mpcDistributeTool);
registerTool(mpcReconstructTool);
registerTool(mpcStatusTool);

// RL (Reinforcement Learning) tools
registerTool(rlRewardStatsTool);
registerTool(rlDopamineLogTool);

// Loci/Graph memory tools
registerTool(graphQueryTool);
registerTool(graphFindPathTool);
registerTool(lociRecallTool);
registerTool(sequenceRecommendTool);

// Line-based edit tools
registerTool(insertAtLineTool);
registerTool(deleteLinesTool);
registerTool(replaceLinesTool);
registerTool(replaceContentTool);

// Project memory tools
registerTool(writeMemoryTool);
registerTool(readMemoryTool);
registerTool(listMemoriesTool);
registerTool(deleteMemoryTool);
registerTool(editMemoryTool);

// Kanban task management tools
registerTool(taskCreateTool);
registerTool(taskListTool);
registerTool(taskClaimTool);
registerTool(taskAssignTool);
registerTool(taskUpdateTool);
registerTool(boardStatusTool);
registerTool(taskPushMultiTool);

// Kanban workspace tools
registerTool(workspaceCreateTool);
registerTool(workspaceListTool);
registerTool(workspaceJoinTool);
registerTool(workspaceLeaveTool);

// Kanban board tools
registerTool(boardCreateTool);
registerTool(boardListTool);
registerTool(boardShareTool);
registerTool(boardMembersTool);
registerTool(boardInviteTool);

// Recursive tool invocation
registerTool(invokeToolTool);
registerTool(invokeBatchTool);
registerTool(invocationLogTool);

// Session management tools
registerTool(sessionListTool);
registerTool(sessionInfoTool);
registerTool(sessionCreateTool);
registerTool(sessionSwitchTool);
registerTool(sessionDeleteTool);

// System configuration tools
registerTool(aiConfigTool);
registerTool(aiModelsTool);

// Multi-LLM tools
registerTool(multiPromptTool);
registerTool(consensusPromptTool);

export * from './registry.js';
