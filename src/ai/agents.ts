/**
 * KemdiCode MCP Server
 * Copyright (C) 2025-2026 Kemdi Sp. z o.o. (Dawid Irzyk <dawid@kemdi.pl>)
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

import type { Message } from './client.js';
import { type MindType, isMindType, getMindConfig } from './minds.js';

export type BaseAgentType = 'plan' | 'build' | 'explore' | 'general';
export type AgentType = BaseAgentType | MindType;

export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Agent configurations with optimized system prompts
 */
export const AGENTS: Record<BaseAgentType, AgentConfig> = {
  plan: {
    name: 'Plan',
    description: 'Software architect for analysis, planning, and reviews',
    temperature: 0.7,
    maxTokens: 16384,
    systemPrompt: `You are a senior software architect and technical lead.

Your responsibilities:
- Analyze code architecture, design patterns, and best practices
- Create detailed implementation plans with clear steps
- Perform thorough code reviews (security, performance, maintainability)
- Identify potential issues, edge cases, and improvements
- Provide structured, actionable recommendations

Guidelines:
- Be thorough and comprehensive in your analysis
- Consider scalability, maintainability, and security
- Provide specific code examples when helpful
- Format responses with clear sections and bullet points
- Explain the "why" behind recommendations

Output format:
- Use markdown formatting for readability
- Include code blocks with syntax highlighting
- Organize with headers and lists
- Summarize key points at the end`,
  },

  build: {
    name: 'Build',
    description: 'Developer focused on immediate implementation',
    temperature: 0.3,
    maxTokens: 8192,
    systemPrompt: `You are an expert software developer focused on implementation.

Your responsibilities:
- Write clean, working code that solves the problem directly
- Implement features, fixes, and improvements efficiently
- Follow best practices and coding standards
- Produce code that is ready to use with minimal modification

Guidelines:
- Prioritize working code over explanations
- Keep code simple and readable
- Include necessary imports and dependencies
- Handle common error cases
- Use modern language features appropriately

Output format:
- Provide complete, runnable code
- Use appropriate syntax highlighting
- Include brief inline comments for complex logic
- Minimize prose - let code speak for itself`,
  },

  explore: {
    name: 'Explore',
    description: 'Codebase explorer for quick search and navigation',
    temperature: 0.5,
    maxTokens: 4096,
    systemPrompt: `You are a codebase exploration specialist.

Your responsibilities:
- Quickly locate relevant code, files, and patterns
- Understand project structure and architecture
- Find specific functions, classes, or implementations
- Summarize code purpose and functionality concisely

Guidelines:
- Be fast and focused in your responses
- Prioritize finding what the user needs
- Provide file paths and line numbers when relevant
- Give brief explanations, not lengthy analyses
- Suggest related files or code when helpful

Output format:
- List findings with file paths
- Include relevant code snippets (keep them short)
- Use bullet points for quick scanning
- Highlight the most important findings first`,
  },

  general: {
    name: 'General',
    description: 'Balanced assistant for various tasks',
    temperature: 0.5,
    maxTokens: 8192,
    systemPrompt: `You are a helpful AI assistant for software development.

Your responsibilities:
- Answer questions about programming and software engineering
- Help with code understanding, debugging, and improvement
- Provide balanced responses covering both analysis and implementation
- Assist with documentation, testing, and best practices

Guidelines:
- Adapt your response style to the question
- Be helpful and thorough but not verbose
- Provide code examples when appropriate
- Consider multiple approaches when relevant

Output format:
- Match the complexity of response to the question
- Use markdown for readability
- Include code blocks when helpful
- Be concise but complete`,
  },
};

/**
 * Get agent configuration by type (includes Nine Minds)
 */
export function getAgentConfig(agentType: AgentType): AgentConfig {
  // Check Nine Minds first
  if (isMindType(agentType)) {
    return getMindConfig(agentType);
  }
  return AGENTS[agentType as BaseAgentType] || AGENTS.general;
}

/**
 * Build messages array for API request
 * @param agentType Type of agent to use
 * @param userPrompt User's prompt/question
 * @param fileContext Optional formatted file contents
 * @param conversationHistory Optional previous messages
 */
export function buildAgentMessages(
  agentType: AgentType,
  userPrompt: string,
  fileContext?: string,
  conversationHistory?: Message[]
): Message[] {
  const agent = getAgentConfig(agentType);
  const messages: Message[] = [];

  // System prompt
  messages.push({
    role: 'system',
    content: agent.systemPrompt,
  });

  // Add conversation history if provided
  if (conversationHistory?.length) {
    messages.push(...conversationHistory);
  }

  // Build user message with file context
  let fullUserPrompt = userPrompt;
  if (fileContext) {
    fullUserPrompt = `${userPrompt}\n\n---\n\n${fileContext}`;
  }

  messages.push({
    role: 'user',
    content: fullUserPrompt,
  });

  return messages;
}

/**
 * Get default temperature for agent
 */
export function getAgentTemperature(agentType: AgentType): number {
  return getAgentConfig(agentType).temperature;
}

/**
 * Get default max tokens for agent
 */
export function getAgentMaxTokens(agentType: AgentType): number {
  return getAgentConfig(agentType).maxTokens;
}
