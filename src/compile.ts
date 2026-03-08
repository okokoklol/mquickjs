/**
 * mquickjs/compile — Node compiler entrypoint
 *
 * Uses @swc/core under Node and exposes the shared CompileJS API.
 */

import {
  parseSync,
  transformSync,
  type Options as SwcTransformOptions,
  type ParseOptions as SwcParseOptions,
} from "@swc/core";

import {
  CompileJS,
  type CompileOptions,
  type Swc,
} from "./compile_shared.js";

const swc: Swc = {
  parse(code, options) {
    return parseSync(code, createParseOptions());
  },
  transform(code, options) {
    return transformSync(code, createTransformOptions(options)).code;
  },
};

const compiler = new CompileJS(swc);

/** Create a compiler backed by @swc/core. */
function createCompileJS(): CompileJS {
  return new CompileJS(swc);
}

/** Compile modern JavaScript to MicroQuickJS-compatible ES3. */
function compile(code: string, options?: CompileOptions): string {
  return compiler.compile(code, options);
}

function createParseOptions(): SwcParseOptions & { isModule: false } {
  return {
    isModule: false,
    syntax: "ecmascript",
  };
}

function createTransformOptions(options?: CompileOptions): SwcTransformOptions {
  if (options?.filename === undefined) {
    return {
      isModule: false,
      jsc: {
        parser: {
          syntax: "ecmascript",
        },
        target: "es3",
      },
    };
  }

  return {
    filename: options.filename,
    isModule: false,
    jsc: {
      parser: {
        syntax: "ecmascript",
      },
      target: "es3",
    },
  };
}

export {
  CompileJS,
  compile,
  createCompileJS,
  type CompileOptions,
  type Swc,
};
