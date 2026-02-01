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
import type { UnifiedTool } from '../registry.js';
import { clientElicitInput, hasCapability, getClientVersion } from '../../client/bridge.js';

const fieldSchema = z
  .object({
    type: z.enum(['string', 'number', 'integer', 'boolean']).describe('Field data type'),
    title: z.string().optional().describe('Display title for the field'),
    description: z.string().optional().describe('Help text or description'),
    default: z
      .union([z.string(), z.number(), z.boolean()])
      .optional()
      .describe('Default value'),
    enum: z.array(z.string()).optional().describe('Allowed values (creates a dropdown)'),
    enumNames: z.array(z.string()).optional().describe('Display names for enum values'),
    format: z
      .enum(['date', 'uri', 'email', 'date-time'])
      .optional()
      .describe('String format constraint'),
  })
  .describe('Field definition');

const schema = z.object({
  message: z.string().describe('Question or prompt to display to the user'),
  fields: z
    .record(z.string(), fieldSchema)
    .describe('Form fields to present (key = field name, value = field definition)'),
  required: z
    .array(z.string())
    .optional()
    .describe('Names of required fields'),
});

export const clientElicitTool: UnifiedTool = {
  name: 'client-elicit',
  description:
    'Ask the user a question through the MCP client UI with structured form fields. ' +
    'Supports text, number, boolean, and enum fields. ' +
    'Returns the user response (accept with data, decline, or cancel).',
  zodSchema: schema,
  skipContextShare: true,
  metadata: {
    category: 'client',
    tags: ['client', 'elicitation', 'user-input', 'mcp'],
    relatedTools: ['client-sampling', 'client-roots'],
  },
  execute: async (rawArgs) => {
    const args = rawArgs as unknown as z.infer<typeof schema>;

    if (!hasCapability('elicitation')) {
      return JSON.stringify({
        error: 'Client does not support elicitation',
        client: getClientVersion(),
        hint: 'Elicitation requires client-side support for user input forms.',
      });
    }

    const result = await clientElicitInput({
      message: args.message,
      requestedSchema: {
        type: 'object',
        properties: args.fields as Record<string, unknown>,
        required: args.required,
      },
    });

    return JSON.stringify(
      {
        action: result.action,
        content: result.content,
      },
      null,
      2,
    );
  },
};
