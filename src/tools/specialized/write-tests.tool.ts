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

import { z } from 'zod';
import { UnifiedTool } from '../registry.js';
import { executeAI, parseFiles } from '../../ai/index.js';
import { getEnhancedContextString } from '../../utils/projectContext.enhanced.js';
import { recordSuggestion } from '../../context/feedback-loop.js';
import { isSilent } from '../../config/silent.js';

const TYPE_PROMPTS: Record<string, string> = {
  unit: `**UNIT TESTS** - Test individual methods in isolation, mock dependencies, use PHPUnit assertions. Location: tests/Unit/`,
  feature: `**FEATURE TESTS** - Test complete flows via HTTP, use actingAs() for auth, test response status/JSON. Location: tests/Feature/`,
  both: `**UNIT + FEATURE** - Generate both types where appropriate.`,
};

const COVERAGE_PROMPTS: Record<string, string> = {
  'happy-path': `**HAPPY PATH** - Test main success scenarios, basic input validation`,
  'edge-cases': `**EDGE CASES** - Empty data, null values, boundary conditions, invalid types, missing relations`,
  full: `**FULL COVERAGE** - Happy path + edge cases + error handling + authorization + DB transactions + events/jobs`,
};

const schema = z.object({
  files: z.string().describe('Files to test. Use @path/file syntax for multiple files, or plain paths separated by spaces'),
  type: z.enum(['unit', 'feature', 'both']).default('unit'),
  coverage: z.enum(['happy-path', 'edge-cases', 'full']).default('happy-path'),
});

export const writeTestsTool: UnifiedTool = {
  name: 'write-tests',
  description: 'Generate PHPUnit tests for Laravel code',
  zodSchema: schema,
  prompt: { description: 'Generate tests for PHP/Laravel files' },
  metadata: {
    category: 'specialized',
    tags: ['test', 'generation', 'tdd'],
    longRunning: true,
    aiRequired: { fallbackTools: ['file-read', 'file-write'] },
    aiRouting: 'hybrid',
    examples: [
      { args: { files: '@app/Services/PaymentService.php', type: 'unit', coverage: 'happy-path' }, description: 'Generate unit tests for a service' },
      { args: { files: '@app/Http/Controllers/OrderController.php', type: 'feature', coverage: 'full' }, description: 'Generate full-coverage feature tests' },
    ],
    relatedTools: ['run-tests', 'code-review', 'explain-code'],
  },
  execute: async (args, onProgress) => {
    const { files, type = 'unit', coverage = 'happy-path' } = args;
    if (!files?.toString().trim()) throw new Error('Files required. Use @path/file.php syntax.');

    const filesStr = String(files);
    const silent = isSilent();

    const prompt = silent
      ? `${getEnhancedContextString()}
Generate tests (${type}, ${coverage}) for: ${filesStr}
Output: raw test code only, no explanations, no markdown fences.`
      : `${getEnhancedContextString()}
# Generate Tests Request

${TYPE_PROMPTS[type as string]}
${COVERAGE_PROMPTS[coverage as string]}

## Files to Test
${filesStr}

## Laravel Test Patterns

\`\`\`php
// Unit Test Pattern
class ExampleServiceTest extends TestCase
{
    private ExampleService $service;

    protected function setUp(): void
    {
        parent::setUp();
        $this->service = new ExampleService(
            $this->createMock(DependencyInterface::class)
        );
    }

    public function test_method_does_something(): void
    {
        // Arrange
        $input = [...];

        // Act
        $result = $this->service->method($input);

        // Assert
        $this->assertEquals($expected, $result);
    }
}

// Feature Test Pattern
class ExampleControllerTest extends TestCase
{
    use RefreshDatabase;

    public function test_endpoint_returns_success(): void
    {
        $user = User::factory()->create();

        $response = $this->actingAs($user)
            ->postJson('/api/endpoint', ['data' => 'value']);

        $response->assertStatus(200)
            ->assertJsonStructure(['id', 'name']);
    }
}
\`\`\`

## Requirements
- Complete, runnable test files
- Proper namespace and imports
- setUp() method if needed
- Descriptive test names (test_it_does_something)
- AAA pattern (Arrange, Act, Assert)
- Data providers for multiple cases where useful

Begin generating tests:`;

    onProgress?.(`Generating tests (${type}, ${coverage}): ${filesStr}`);
    const result = await executeAI({ prompt, agent: 'plan', files: parseFiles(filesStr), onProgress });

    // Record suggestions for feedback tracking
    const parsedFiles = parseFiles(filesStr);
    for (const file of parsedFiles) {
      recordSuggestion(
        'write-tests',
        file,
        'test',
        `Test generation (${type}, ${coverage})`,
        result.slice(0, 500)
      ).catch(() => {
        /* ignore errors */
      });
    }

    return result;
  },
};
