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

/**
 * Project Memory Tools Module
 *
 * Exports consolidated memory and checkpoint tools.
 * v4.2.0: 8 tools consolidated into 2 action-based tools.
 *
 * @module tools/memory
 */

export { memoryTool } from './memory.tool.js';
export { checkpointTool } from './checkpoint.tool.js';

// Legacy exports (kept for internal use by registry auto-save)
export { writeMemoryTool } from './write-memory.tool.js';
export { readMemoryTool } from './read-memory.tool.js';
export { listMemoriesTool } from './list-memories.tool.js';
export { deleteMemoryTool } from './delete-memory.tool.js';
export { editMemoryTool } from './edit-memory.tool.js';
export { checkpointSaveTool } from './checkpoint-save.tool.js';
export { checkpointRestoreTool } from './checkpoint-restore.tool.js';
export { checkpointDiffTool } from './checkpoint-diff.tool.js';
