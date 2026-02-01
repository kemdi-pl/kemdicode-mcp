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
 * Project Tools Index
 *
 * Exports all project management tools:
 * - project-info: Read project metadata
 * - run-script: Execute npm/composer scripts
 * - check-types: TypeScript/PHPStan type checking
 * - run-lint: ESLint/PHPCS/PHPStan linting
 * - run-tests: Jest/Vitest/PHPUnit testing
 *
 * @module tools/project
 */

export { projectInfoTool } from './project-info.tool.js';
export { runScriptTool } from './run-script.tool.js';
export { checkTypesTool } from './check-types.tool.js';
export { runLintTool } from './run-lint.tool.js';
export { runTestsTool } from './run-tests.tool.js';
