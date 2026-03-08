/**
 * mquickjs/compile — shared compiler pieces
 *
 * Keeps the public API independent from a specific SWC backend.
 */

/**
 * Compiler options.
 */
interface CompileOptions {
  /** Source filename for parser and transform errors. */
  filename?: string;
}

/**
 * SWC adapter used by CompileJS.
 */
interface Swc {
  parse(code: string, options?: CompileOptions): unknown;
  transform(code: string, options?: CompileOptions): string;
}

class CompileJS {
  private readonly swc: Swc;

  constructor(swc: Swc) {
    this.swc = swc;
  }

  /** Compile modern JavaScript to MicroQuickJS-compatible ES3. */
  compile(code: string, options?: CompileOptions): string {
    validate(this.swc.parse(code, options));
    return this.swc.transform(code, options);
  }
}

// –
// Validation
// –

/**
 * Minimal AST node shape needed for validation.
 */
interface AstNode {
  type: string;
}

function isAstNode(value: unknown): value is AstNode {
  return isRecord(value) && typeof value.type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Walk every node in an SWC AST. */
function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visit);
    }
    return;
  }

  if (!isRecord(node)) {
    return;
  }

  if (isAstNode(node)) {
    visit(node);
  }

  for (const value of Object.values(node)) {
    walk(value, visit);
  }
}

/** Reject features that MicroQuickJS cannot run after transform. */
function validate(ast: unknown): void {
  const issues = new Set<string>();

  walk(ast, (node) => {
    if (hasTrue(node, "async")) {
      issues.add("async functions (no Promise)");
    }

    if (hasTrue(node, "generator")) {
      issues.add("generator functions (no runtime)");
    }

    if (node.type === "AwaitExpression") {
      issues.add("await (no Promise)");
    }

    if (node.type === "CallExpression" && isDynamicImport(node)) {
      issues.add("dynamic import (no module loader or Promise)");
    }

    if (node.type === "ForOfStatement" && hasKey(node, "await")) {
      issues.add("for await (... of ...) (no async iterator runtime)");
    }

    if (node.type === "MetaProperty" && getString(node, "kind") === "import.meta") {
      issues.add("import.meta (no module loader)");
    }

    if (node.type === "YieldExpression") {
      issues.add("yield (no generator runtime)");
    }
  });

  if (issues.size === 0) {
    return;
  }

  const list = [...issues]
    .sort()
    .map((issue) => `  - ${issue}`)
    .join("\n");

  throw new Error(`mquickjs/compile: unsupported features:\n${list}`);
}

function getString(node: AstNode, key: string): string | undefined {
  if (!isRecord(node)) {
    return undefined;
  }

  const value = node[key];
  return typeof value === "string" ? value : undefined;
}

function hasKey(node: AstNode, key: string): boolean {
  return isRecord(node) && key in node && node[key] !== undefined;
}

function hasTrue(node: AstNode, key: string): boolean {
  return isRecord(node) && node[key] === true;
}

function isDynamicImport(node: AstNode): boolean {
  if (!isRecord(node)) {
    return false;
  }

  const callee = node.callee;
  return isAstNode(callee) && callee.type === "Import";
}

export {
  CompileJS,
  type CompileOptions,
  type Swc,
};
