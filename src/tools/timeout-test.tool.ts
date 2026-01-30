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

import { z } from 'zod';
import { UnifiedTool } from './registry.js';

const timeoutTestArgsSchema = z.object({
  duration: z.number().min(10).describe('Duration in milliseconds (min 10ms)'),
});

export const timeoutTestTool: UnifiedTool = {
  name: 'timeout-test',
  description: 'Test timeout prevention for specified duration',
  zodSchema: timeoutTestArgsSchema,
  prompt: { description: 'Test timeout prevention system' },
  execute: async (args) => {
    const duration = args.duration as number;
    const steps = Math.ceil(duration / 5000); // Progress every 5 seconds
    const stepDuration = duration / steps;
    const startTime = Date.now();

    const results: string[] = [];
    results.push(`Starting timeout test for ${duration}ms (${duration / 1000}s)`);

    for (let i = 1; i <= steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, stepDuration));
      const elapsed = Date.now() - startTime;
      results.push(`Step ${i}/${steps} completed - Elapsed: ${Math.round(elapsed / 1000)}s`);
    }

    const totalElapsed = Date.now() - startTime;
    results.push(`\nTimeout test completed successfully!`);
    results.push(`Target duration: ${duration}ms`);
    results.push(`Actual duration: ${totalElapsed}ms`);

    return results.join('\n');
  },
};
