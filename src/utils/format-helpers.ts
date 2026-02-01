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
 * Shared formatting helpers for tool output.
 *
 * @module utils/format-helpers
 */

/**
 * Sanitize a string for safe terminal output.
 * Strips ANSI escape sequences and control characters that could
 * manipulate cursor position, hide text, or exploit terminal emulators.
 */
export function sanitizeTerminalOutput(str: string): string {
  // Remove ANSI escape sequences (CSI, OSC, etc.)
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '');
}

/**
 * Wrap text at word boundaries to fit within a maximum width.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= maxWidth) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.length > 0 ? lines : [''];
}

/**
 * Get emoji icon for task/message priority.
 */
export function priorityIcon(priority: string): string {
  return (
    {
      critical: '🔴',
      high: '🟠',
      normal: '🟢',
      low: '⚪',
    }[priority] || '⚪'
  );
}

/**
 * Get emoji icon for task status.
 */
export function statusIcon(status: string): string {
  return (
    {
      backlog: '📋',
      in_progress: '🔄',
      review: '👀',
      done: '✅',
    }[status] || '📋'
  );
}
