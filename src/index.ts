/**
 * mquickjs — MicroQuickJS WASM wrapper
 *
 * Embeds the mquickjs ES5 engine in a WASM sandbox with support for
 * runtime-injected host objects. Host handlers may be async — the guest
 * sees them as synchronous calls (via Asyncify stack save/restore).
 */

// –
// Types
// –

/** Sync or async handler exposed to the guest. */
type HostHandler = (...args: unknown[]) => unknown | Promise<unknown>;

/** Handler table for a host object exposed to the guest. */
type HostObject = Record<string, HostHandler>;

interface MQuickJSOptions {
  /** Override WASM file resolution (passed to emscripten's locateFile). */
  locateFile?: (path: string, prefix: string) => string;
  /** Console output handler. Receives each `print()`/`console.log()` line. */
  log?: (message: string) => void;
  /** Guest heap size in bytes. Default: 65536. */
  memorySize?: number;
}

interface EvalOptions {
  /** Execution fuel budget. Each unit ≈ 10,000 bytecode operations.
   *  Omit for unlimited. Throws "interrupted" when exhausted. */
  fuel?: number;
}

/** JSON envelope returned by the C bridge's mqjs_eval. */
interface EvalEnvelope {
  err?: string;
  ok?: unknown;
}

/** Emscripten module shape (subset we use). */
interface EmModule {
  __hostCallback:
    | ((slotId: number, argsJson: string) => string | null | Promise<string | null>)
    | null;
  __logCallback: ((message: string) => void) | null;
  _free: (ptr: number) => void;
  _malloc: (size: number) => number;
  _mqjs_free: () => void;
  _mqjs_init: (memSize: number) => number;
  _mqjs_set_fuel: (fuel: number) => void;
  ccall: (
    name: string,
    returnType: string,
    argTypes: string[],
    args: unknown[],
    opts?: { async?: boolean },
  ) => unknown;
  lengthBytesUTF8: (str: string) => number;
  stringToUTF8: (str: string, ptr: number, maxLen: number) => void;
  UTF8ToString: (ptr: number) => string;
}

type EmFactory = (opts?: Record<string, unknown>) => Promise<EmModule>;

// –
// MQuickJS
// –

class MQuickJS {
  private module: EmModule;
  private slots = new Map<number, HostHandler>();
  private nextSlot = 0;
  private disposed = false;

  private constructor(module: EmModule) {
    this.module = module;
  }

  /**
   * Pre-compile the WASM binary. Call at module init time to eliminate
   * compilation latency from the first `create()`. Safe to call multiple
   * times — only the first call triggers compilation.
   */
  static preload(options?: Pick<MQuickJSOptions, "locateFile">): void {
    getCompiledWasm(options?.locateFile);
  }

  /** Instantiate the WASM engine. */
  static async create(options?: MQuickJSOptions): Promise<MQuickJS> {
    const [factory, wasmModule] = await Promise.all([
      loadFactory(),
      getCompiledWasm(options?.locateFile),
    ]);

    const moduleOpts: Record<string, unknown> = {};
    if (options?.locateFile) {
      moduleOpts.locateFile = options.locateFile;
    }

    /* Reuse compiled WASM module — skip recompilation on subsequent calls */
    moduleOpts.instantiateWasm = (
      imports: WebAssembly.Imports,
      successCallback: (
        instance: WebAssembly.Instance,
        module: WebAssembly.Module,
      ) => void,
    ) => {
      WebAssembly.instantiate(wasmModule, imports).then((instance) => {
        successCallback(instance, wasmModule);
      });
      return {};
    };

    const mod = (await factory(moduleOpts)) as EmModule;
    const engine = new MQuickJS(mod);

    mod.__logCallback = options?.log ?? ((msg: string) => console.log(msg));
    mod.__hostCallback = (slotId: number, argsJson: string) => {
      const handler = engine.slots.get(slotId);
      if (!handler) return null;

      try {
        const args: unknown[] = JSON.parse(argsJson);
        const result = handler(...args);

        /* Async handler — return Promise<string|null> for Asyncify */
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (v) => JSON.stringify(v === undefined ? null : v),
            (e: unknown) =>
              JSON.stringify({
                __error: e instanceof Error ? e.message : String(e),
              }),
          );
        }

        return JSON.stringify(result === undefined ? null : result);
      } catch (e) {
        return JSON.stringify({
          __error: e instanceof Error ? e.message : String(e),
        });
      }
    };

    const memSize = options?.memorySize ?? 65536;
    const rc = mod._mqjs_init(memSize);
    if (rc !== 0) {
      throw new Error("mquickjs: failed to initialize engine");
    }

    return engine;
  }

  /**
   * Evaluate JavaScript code in the guest sandbox.
   *
   * Returns the JSON-round-tripped result of the last expression.
   * Throws on guest exceptions. Async because host calls may suspend
   * the WASM stack via Asyncify.
   */
  async eval(code: string, options?: EvalOptions): Promise<unknown> {
    if (this.disposed) throw new Error("mquickjs: engine disposed");

    const m = this.module;
    m._mqjs_set_fuel(options?.fuel ?? -1);
    const len = m.lengthBytesUTF8(code);
    const ptr = m._malloc(len + 1);
    if (!ptr) throw new Error("mquickjs: malloc failed");

    m.stringToUTF8(code, ptr, len + 1);

    /* ccall with {async:true} returns a Promise when Asyncify suspends */
    const resultPtr = (await m.ccall(
      "mqjs_eval",
      "number",
      ["number", "number"],
      [ptr, len],
      { async: true },
    )) as number;

    m._free(ptr);

    if (!resultPtr) throw new Error("mquickjs: eval returned null");

    const json = m.UTF8ToString(resultPtr);
    const envelope: EvalEnvelope = JSON.parse(json);

    if (envelope.err !== undefined) {
      throw new Error(envelope.err);
    }

    return envelope.ok;
  }

  /**
   * Expose a host object to the guest.
   *
   * Each method becomes callable from guest JS. Arguments and return values
   * are JSON-serialized across the boundary. Handlers may be async — the
   * guest sees them as synchronous (Asyncify suspends/resumes the stack).
   *
   * @example
   * await engine.expose("Std", {
   *   fetch: async (url) => {
   *     const res = await fetch(url);
   *     return { status: res.status, body: await res.text() };
   *   },
   *   env: (key) => process.env[key] ?? null,
   * });
   */
  async expose(name: string, obj: HostObject): Promise<void> {
    if (this.disposed) throw new Error("mquickjs: engine disposed");

    const methods = Object.keys(obj).sort();
    if (methods.length === 0) return;

    const lines = [`var ${name} = {};`];
    for (const method of methods) {
      const slotId = this.nextSlot++;
      this.slots.set(slotId, obj[method]);

      lines.push(
        `${name}.${method} = function() {` +
          `var a = [];` +
          `for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);` +
          `var r = __hostCall(${slotId}, JSON.stringify(a));` +
          `return r !== void 0 ? JSON.parse(r) : void 0;` +
          `};`,
      );
    }

    await this.eval(lines.join("\n"));
  }

  /** Release all resources. The instance is unusable after this call. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.module._mqjs_free();
    this.module.__hostCallback = null;
    this.module.__logCallback = null;
    this.slots.clear();
  }
}

// –
// WASM compilation cache
// –

let compiledWasm: Promise<WebAssembly.Module> | null = null;

/** Compile the WASM binary once, reuse across all instances. */
function getCompiledWasm(
  locateFile?: (path: string, prefix: string) => string,
): Promise<WebAssembly.Module> {
  if (compiledWasm) return compiledWasm;

  compiledWasm = (async () => {
    const wasmUrl = locateFile
      ? locateFile("mquickjs.wasm", "")
      : new URL("mquickjs.wasm", import.meta.url).href;
    const isFileUrl = wasmUrl.startsWith("file:");

    /* Streaming compilation (browsers with HTTP URLs) */
    if (
      !isFileUrl &&
      typeof WebAssembly.compileStreaming === "function" &&
      typeof globalThis.fetch === "function"
    ) {
      try {
        return await WebAssembly.compileStreaming(fetch(wasmUrl));
      } catch {
        /* fall through to non-streaming */
      }
    }

    /* Read bytes: fs for file:// URLs, fetch for http(s) */
    let bytes: BufferSource;
    if (isFileUrl) {
      const fs = (await Function('return import("node:fs")')()) as {
        readFileSync: (path: string) => BufferSource;
      };
      const url = (await Function('return import("node:url")')()) as {
        fileURLToPath: (url: string) => string;
      };
      bytes = fs.readFileSync(url.fileURLToPath(wasmUrl));
    } else if (typeof globalThis.fetch === "function") {
      bytes = await (await fetch(wasmUrl)).arrayBuffer();
    } else {
      const fs = (await Function('return import("node:fs")')()) as {
        readFileSync: (path: string) => BufferSource;
      };
      bytes = fs.readFileSync(wasmUrl);
    }

    return WebAssembly.compile(bytes);
  })();

  return compiledWasm;
}

// –
// Emscripten factory cache
// –

let factoryPromise: Promise<EmFactory> | null = null;

function loadFactory(): Promise<EmFactory> {
  if (factoryPromise) return factoryPromise;

  factoryPromise = (async () => {
    const mod: Record<string, unknown> = await (
      Function('return import("./mquickjs.mjs")')() as Promise<
        Record<string, unknown>
      >
    );
    return (mod.default ?? mod) as EmFactory;
  })();

  return factoryPromise;
}

export {
  MQuickJS,
  type EvalOptions,
  type HostHandler,
  type HostObject,
  type MQuickJSOptions,
};
