/**
 * KemdiCode MCP Server - Schema Registry
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
 * Schema Registry
 *
 * Features:
 * - JSON Schema registration and versioning
 * - Schema validation
 * - Schema inheritance/composition
 * - Schema evolution tracking
 * - Compatibility checking
 *
 * @module services/schema-registry
 */

export type JsonSchema = Record<string, unknown>;

export interface SchemaDefinition {
  name: string;
  version: string;
  schema: JsonSchema;
  description?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SchemaCompatibility {
  compatible: boolean;
  breakingChanges: string[];
  warnings: string[];
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
}

export interface ValidationError {
  path: string;
  message: string;
  value?: unknown;
}

export type SchemaValidator = (data: unknown) => SchemaValidationResult;

export class SchemaRegistry {
  private schemas: Map<string, SchemaDefinition> = new Map();
  private validators: Map<string, SchemaValidator> = new Map();
  private versionHistory: Map<string, string[]> = new Map();

  register(definition: SchemaDefinition): void {
    const key = this.getKey(definition.name, definition.version);

    this.schemas.set(key, {
      ...definition,
      createdAt: this.schemas.get(key)?.createdAt || Date.now(),
      updatedAt: Date.now(),
    });

    const history = this.versionHistory.get(definition.name) || [];
    if (!history.includes(definition.version)) {
      history.push(definition.version);
      this.versionHistory.set(definition.name, history);
    }

    this.buildValidator(definition);
  }

  get(name: string, version: string): SchemaDefinition | null {
    return this.schemas.get(this.getKey(name, version)) || null;
  }

  getLatest(name: string): SchemaDefinition | null {
    const versions = this.versionHistory.get(name);
    if (!versions || versions.length === 0) return null;

    const latestVersion = versions[versions.length - 1];
    return this.get(name, latestVersion);
  }

  getVersions(name: string): string[] {
    return this.versionHistory.get(name) || [];
  }

  validate(name: string, version: string, data: unknown): SchemaValidationResult {
    const key = this.getKey(name, version);
    const validator = this.validators.get(key);

    if (!validator) {
      return {
        valid: false,
        errors: [{ path: '', message: `Schema not found: ${name}@${version}` }],
        warnings: [],
      };
    }

    return validator(data);
  }

  validateLatest(name: string, data: unknown): SchemaValidationResult {
    const latest = this.getLatest(name);
    if (!latest) {
      return {
        valid: false,
        errors: [{ path: '', message: `Schema not found: ${name}` }],
        warnings: [],
      };
    }

    return this.validate(name, latest.version, data);
  }

  checkCompatibility(name: string, oldVersion: string, newSchema: JsonSchema): SchemaCompatibility {
    const oldDefinition = this.get(name, oldVersion);
    if (!oldDefinition) {
      return {
        compatible: false,
        breakingChanges: [`Previous version ${oldVersion} not found`],
        warnings: [],
      };
    }

    const breaking: string[] = [];
    const warnings: string[] = [];

    const oldProps = this.getProperties(oldDefinition.schema);
    const newProps = this.getProperties(newSchema);

    for (const [prop, oldType] of Object.entries(oldProps)) {
      if (!(prop in newProps)) {
        breaking.push(`Removed property: ${prop}`);
      } else if (newProps[prop] !== oldType && !this.isCompatibleType(oldType, newProps[prop])) {
        breaking.push(`Changed type of ${prop}: ${oldType} -> ${newProps[prop]}`);
      }
    }

    for (const prop of Object.keys(newProps)) {
      if (!(prop in oldProps)) {
        warnings.push(`Added optional property: ${prop}`);
      }
    }

    return {
      compatible: breaking.length === 0,
      breakingChanges: breaking,
      warnings,
    };
  }

  private getProperties(schema: JsonSchema, prefix = ''): Record<string, string> {
    const props: Record<string, string> = {};

    if (typeof schema !== 'object' || schema === null) return props;

    const schemaObj = schema as Record<string, unknown>;

    if (schemaObj.type === 'object' && schemaObj.properties) {
      const properties = schemaObj.properties as Record<string, JsonSchema>;
      for (const [key, value] of Object.entries(properties)) {
        const type = this.getType(value);
        props[`${prefix}${prefix ? '.' : ''}${key}`] = type;
      }
    }

    return props;
  }

  private getType(schema: JsonSchema): string {
    if (typeof schema !== 'object' || schema === null) return 'unknown';

    const schemaObj = schema as Record<string, unknown>;

    if (schemaObj.type) {
      if (schemaObj.type === 'array' && schemaObj.items) {
        return `array<${this.getType(schemaObj.items as JsonSchema)}>`;
      }
      return schemaObj.type as string;
    }

    if (schemaObj.oneOf || schemaObj.anyOf) {
      return 'union';
    }

    return 'unknown';
  }

  private isCompatibleType(oldType: string, newType: string): boolean {
    const compat: Record<string, string[]> = {
      integer: ['integer', 'number'],
      number: ['number'],
      string: ['string'],
      boolean: ['boolean'],
      array: ['array'],
      object: ['object'],
    };

    return compat[oldType]?.includes(newType) || false;
  }

  private buildValidator(definition: SchemaDefinition): void {
    const key = this.getKey(definition.name, definition.version);

    const validator = (data: unknown): SchemaValidationResult => {
      const errors: ValidationError[] = [];
      const warnings: string[] = [];

      this.validateSchema(definition.schema, data, '', errors, warnings);

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    };

    this.validators.set(key, validator);
  }

  private validateSchema(
    schema: JsonSchema,
    data: unknown,
    path: string,
    errors: ValidationError[],
    warnings: string[]
  ): void {
    if (typeof schema !== 'object' || schema === null) return;

    const schemaObj = schema as Record<string, unknown>;

    if (data === undefined || data === null) {
      if (schemaObj.required && !Array.isArray(schemaObj.required)) {
        errors.push({ path, message: 'Value is required', value: data });
      }
      return;
    }

    if (schemaObj.type) {
      const actualType = this.getValueType(data);

      if (schemaObj.type === 'array' && !Array.isArray(data)) {
        errors.push({ path, message: `Expected array, got ${actualType}`, value: data });
        return;
      }

      if (schemaObj.type === 'object' && (typeof data !== 'object' || Array.isArray(data))) {
        errors.push({ path, message: `Expected object, got ${actualType}`, value: data });
        return;
      }

      if (schemaObj.type === 'number' && typeof data !== 'number') {
        errors.push({ path, message: `Expected number, got ${actualType}`, value: data });
        return;
      }

      if (schemaObj.type === 'string' && typeof data !== 'string') {
        errors.push({ path, message: `Expected string, got ${actualType}`, value: data });
        return;
      }

      if (schemaObj.type === 'boolean' && typeof data !== 'boolean') {
        errors.push({ path, message: `Expected boolean, got ${actualType}`, value: data });
        return;
      }
    }

    if (schemaObj.properties && typeof data === 'object') {
      const required = schemaObj.required as string[] | undefined;
      const properties = schemaObj.properties as Record<string, JsonSchema>;

      for (const [key, propSchema] of Object.entries(properties)) {
        const propPath = path ? `${path}.${key}` : key;
        const propValue = (data as Record<string, unknown>)[key];

        if (propValue === undefined && required?.includes(key)) {
          errors.push({ path: propPath, message: `Missing required property: ${key}` });
        } else if (propValue !== undefined) {
          this.validateSchema(propSchema, propValue, propPath, errors, warnings);
        }
      }
    }
  }

  private getValueType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  private getKey(name: string, version: string): string {
    return `${name}@${version}`;
  }

  list(): SchemaDefinition[] {
    return [...this.schemas.values()];
  }

  listNames(): string[] {
    return [...this.versionHistory.keys()];
  }

  remove(name: string, version: string): boolean {
    const key = this.getKey(name, version);
    const removed = this.schemas.delete(key);

    if (removed) {
      this.validators.delete(key);
      const history = this.versionHistory.get(name);
      if (history) {
        const idx = history.indexOf(version);
        if (idx > -1) history.splice(idx, 1);
      }
    }

    return removed;
  }

  toJSON(): Record<string, SchemaDefinition[]> {
    const result: Record<string, SchemaDefinition[]> = {};

    for (const [name, versions] of this.versionHistory) {
      result[name] = versions.map((v) => this.get(name, v)!);
    }

    return result;
  }

  async import(data: Record<string, SchemaDefinition[]>): Promise<{
    imported: number;
    errors: string[];
  }> {
    let imported = 0;
    const errors: string[] = [];

    for (const [, schemas] of Object.entries(data)) {
      for (const schema of schemas) {
        try {
          this.register(schema);
          imported++;
        } catch (error) {
          errors.push(`Failed to import ${schema.name}@${schema.version}: ${error}`);
        }
      }
    }

    return { imported, errors };
  }
}

export const schemaRegistry = new SchemaRegistry();

export function createSchemaValidator<T = unknown>(
  schema: JsonSchema
): (data: unknown) => data is T {
  const registry = new SchemaRegistry();
  registry.register({
    name: 'temp',
    version: '1.0.0',
    schema,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  return (data: unknown): data is T => {
    const result = registry.validateLatest('temp', data);
    return result.valid;
  };
}
