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
 * Workspace Editor for OpenAI Agents SDK
 *
 * Implements the Editor interface for file operations with diff-based patching.
 * Used by applyPatchTool for multi-agent file editing workflows.
 *
 * @module ai/workspace-editor
 */

import { applyDiff } from '@openai/agents';
import type { Editor, ApplyPatchOperation, ApplyPatchResult } from '@openai/agents';
import { readFile, writeFile, mkdir, rm, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '../utils/logger.js';

export interface WorkspaceEditorOptions {
  /** Root directory for file operations */
  root: string;
  /** Create backup files before modifications */
  createBackups?: boolean;
  /** Allow operations outside root (dangerous) */
  allowOutsideRoot?: boolean;
}

/**
 * WorkspaceEditor implements the OpenAI Agents Editor interface
 * for safe file operations within a workspace.
 */
export class WorkspaceEditor implements Editor {
  private readonly root: string;
  private readonly createBackups: boolean;
  private readonly allowOutsideRoot: boolean;

  constructor(options: WorkspaceEditorOptions) {
    this.root = path.resolve(options.root);
    this.createBackups = options.createBackups ?? true;
    this.allowOutsideRoot = options.allowOutsideRoot ?? false;
  }

  /**
   * Resolve and validate a file path
   */
  private async resolve(relativePath: string): Promise<string> {
    const resolved = path.resolve(this.root, relativePath);

    if (!this.allowOutsideRoot && !resolved.startsWith(this.root)) {
      throw new Error(`Operation outside workspace not allowed: ${relativePath}`);
    }

    return resolved;
  }

  /**
   * Create a backup of a file before modification
   */
  private async backup(filePath: string): Promise<string | undefined> {
    if (!this.createBackups) return undefined;

    try {
      await access(filePath);
      const backupPath = `${filePath}.bak`;
      await copyFile(filePath, backupPath);
      Logger.debug(`workspace-editor: Created backup ${backupPath}`);
      return backupPath;
    } catch {
      // File doesn't exist, no backup needed
      return undefined;
    }
  }

  /**
   * Create a new file with the given diff content
   */
  async createFile(
    operation: Extract<ApplyPatchOperation, { type: 'create_file' }>
  ): Promise<ApplyPatchResult | void> {
    const targetPath = await this.resolve(operation.path);

    try {
      // Ensure directory exists
      await mkdir(path.dirname(targetPath), { recursive: true });

      // Apply diff to create content from empty string
      const content = applyDiff('', operation.diff, 'create');

      // Write file
      await writeFile(targetPath, content, 'utf8');

      Logger.info(`workspace-editor: Created file ${operation.path}`);

      return {
        status: 'completed',
        output: `Created ${operation.path}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.error(`workspace-editor: Failed to create ${operation.path}: ${message}`);

      return {
        status: 'failed',
        output: `Failed to create ${operation.path}: ${message}`,
      };
    }
  }

  /**
   * Update an existing file with the given diff
   */
  async updateFile(
    operation: Extract<ApplyPatchOperation, { type: 'update_file' }>
  ): Promise<ApplyPatchResult | void> {
    const targetPath = await this.resolve(operation.path);

    try {
      // Read original content
      const original = await readFile(targetPath, 'utf8');

      // Create backup before modification
      const backupPath = await this.backup(targetPath);

      // Apply diff patch
      const patched = applyDiff(original, operation.diff);

      // Write patched content
      await writeFile(targetPath, patched, 'utf8');

      Logger.info(`workspace-editor: Updated file ${operation.path}`);

      return {
        status: 'completed',
        output: `Updated ${operation.path}${backupPath ? ` (backup: ${backupPath})` : ''}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.error(`workspace-editor: Failed to update ${operation.path}: ${message}`);

      return {
        status: 'failed',
        output: `Failed to update ${operation.path}: ${message}`,
      };
    }
  }

  /**
   * Delete a file
   */
  async deleteFile(
    operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>
  ): Promise<ApplyPatchResult | void> {
    const targetPath = await this.resolve(operation.path);

    try {
      // Create backup before deletion
      await this.backup(targetPath);

      // Delete file
      await rm(targetPath, { force: true });

      Logger.info(`workspace-editor: Deleted file ${operation.path}`);

      return {
        status: 'completed',
        output: `Deleted ${operation.path}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.error(`workspace-editor: Failed to delete ${operation.path}: ${message}`);

      return {
        status: 'failed',
        output: `Failed to delete ${operation.path}: ${message}`,
      };
    }
  }
}

/**
 * Create a WorkspaceEditor for the current working directory
 */
export function createWorkspaceEditor(options?: Partial<WorkspaceEditorOptions>): WorkspaceEditor {
  return new WorkspaceEditor({
    root: options?.root ?? process.cwd(),
    createBackups: options?.createBackups ?? true,
    allowOutsideRoot: options?.allowOutsideRoot ?? false,
  });
}
