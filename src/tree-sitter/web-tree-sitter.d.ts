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
 * Type declarations for web-tree-sitter default export
 *
 * The web-tree-sitter package exports Parser as both default and named export,
 * but TypeScript has trouble with this pattern. This file provides proper typing.
 */

declare module 'web-tree-sitter' {
  export interface Point {
    row: number;
    column: number;
  }

  export interface Range {
    startPosition: Point;
    endPosition: Point;
    startIndex: number;
    endIndex: number;
  }

  export class Language {
    static load(path: string | Uint8Array): Promise<Language>;
    types: string[];
    fields: (string | null)[];
    get name(): string | null;
    get abiVersion(): number;
    fieldIdForName(fieldName: string): number | null;
  }

  export class Tree {
    language: Language;
    get rootNode(): SyntaxNode;
    copy(): Tree;
    delete(): void;
    walk(): TreeCursor;
    getChangedRanges(other: Tree): Range[];
  }

  export class SyntaxNode {
    id: number;
    tree: Tree;
    startIndex: number;
    startPosition: Point;
    get endIndex(): number;
    get endPosition(): Point;
    get type(): string;
    get typeId(): number;
    get text(): string;
    get isNamed(): boolean;
    get isError(): boolean;
    get isMissing(): boolean;
    get hasChanges(): boolean;
    get hasError(): boolean;
    get childCount(): number;
    get namedChildCount(): number;
    get firstChild(): SyntaxNode | null;
    get lastChild(): SyntaxNode | null;
    get firstNamedChild(): SyntaxNode | null;
    get lastNamedChild(): SyntaxNode | null;
    get parent(): SyntaxNode | null;
    get nextSibling(): SyntaxNode | null;
    get previousSibling(): SyntaxNode | null;
    get nextNamedSibling(): SyntaxNode | null;
    get previousNamedSibling(): SyntaxNode | null;
    get children(): SyntaxNode[];
    get namedChildren(): SyntaxNode[];
    child(index: number): SyntaxNode | null;
    namedChild(index: number): SyntaxNode | null;
    childForFieldId(fieldId: number): SyntaxNode | null;
    childForFieldName(fieldName: string): SyntaxNode | null;
    descendantForIndex(start: number, end?: number): SyntaxNode | null;
    descendantForPosition(start: Point, end?: Point): SyntaxNode | null;
    descendantsOfType(
      types: string | string[],
      startPosition?: Point,
      endPosition?: Point
    ): SyntaxNode[];
    walk(): TreeCursor;
    equals(other: SyntaxNode): boolean;
    toString(): string;
  }

  export class TreeCursor {
    get currentNode(): SyntaxNode;
    get currentFieldName(): string | null;
    get nodeType(): string;
    get nodeText(): string;
    get startPosition(): Point;
    get endPosition(): Point;
    copy(): TreeCursor;
    delete(): void;
    gotoFirstChild(): boolean;
    gotoLastChild(): boolean;
    gotoParent(): boolean;
    gotoNextSibling(): boolean;
    gotoPreviousSibling(): boolean;
    reset(node: SyntaxNode): void;
  }

  export interface ParseOptions {
    includedRanges?: Range[];
  }

  export default class Parser {
    static init(moduleOptions?: object): Promise<void>;
    static Language: typeof Language;
    language: Language | null;
    constructor();
    delete(): void;
    setLanguage(language: Language | null): this;
    parse(
      input: string | ((index: number, position: Point) => string | undefined),
      oldTree?: Tree | null,
      options?: ParseOptions
    ): Tree | null;
    reset(): void;
  }
}
