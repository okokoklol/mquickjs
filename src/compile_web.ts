/**
 * mquickjs/compile/web — browser compiler entrypoint
 *
 * Uses @swc/wasm-web and hides its one-time async initialization.
 */

import initSwc, {
  parseSync,
  transformSync,
  type InitInput,
  type Options as SwcTransformOptions,
  type ParseOptions as SwcParseOptions,
} from "@swc/wasm-web";

import {
  CompileJS,
  type CompileOptions,
  type Swc,
} from "./compile_shared.js";

/**
 * Browser compiler initialization options.
 */
interface CompileJSWebOptions {
  /** Optional SWC WASM source passed through to @swc/wasm-web. */
  module?: InitInput | Promise<InitInput>;
}

const swc: Swc = {
  parse(code, options) {
    return parseSync(code, createParseOptions());
  },
  transform(code, options) {
    return transformSync(code, createTransformOptions(options)).code;
  },
};

let compiler: CompileJS | null = null;
let ready: Promise<void> | null = null;

/** Initialize @swc/wasm-web once. */
function init(options?: CompileJSWebOptions): Promise<void> {
  if (ready) {
    return ready;
  }

  ready = (async () => {
    if (options?.module === undefined) {
      await initSwc();
      return;
    }

    await initSwc({ module_or_path: options.module });
  })();

  return ready;
}

/** Create a compiler backed by @swc/wasm-web. */
async function createCompileJS(options?: CompileJSWebOptions): Promise<CompileJS> {
  await init(options);
  return new CompileJS(swc);
}

/** Compile modern JavaScript to MicroQuickJS-compatible ES3. */
async function compile(code: string, options?: CompileOptions): Promise<string> {
  if (compiler === null) {
    compiler = await createCompileJS();
  }

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
  init,
  type CompileJSWebOptions,
  type CompileOptions,
  type Swc,
};
