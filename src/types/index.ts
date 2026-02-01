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
 * Type Definitions Index
 *
 * Central export point for all shared type definitions.
 *
 * @module types
 */

// Tool-related types
export * from './tool-types.js';

// Git operation types
export * from './git-types.js';

// File operation types - exclude FileTreeArguments as it's already exported from tool-types
export {
  FileType,
  FileMetadata,
  FileContent,
  TreeEntry,
  FileTreeResult,
  FileSearchMatch,
  FileSearchResult,
  FileDiffChange,
  FileDiffResult,
  FileReadArguments,
  FileWriteArguments,
  FileWriteResult,
  FileSearchArguments,
  FileErrorCode,
  FileOperationError,
  isFileError,
  isNodeFsError,
  toFileError,
} from './file-types.js';
