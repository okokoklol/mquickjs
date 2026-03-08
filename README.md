# mquickjs

Tiny and fast JS sandbox for untrusted code, compiled to WebAssembly. Runs in browsers, Node, Bun, Deno, Vercel, Cloudflare — anywhere WASM runs.

Powered by [MicroQuickJS](https://github.com/bellard/mquickjs) by Fabrice Bellard.

## Features

- **No expensive sandboxes.** Run guest code in an in-process JS sandbox without spinning up linux VMs.
- **Expose host APIs.** Use `engine.expose` to make JS APIs callable from guest code.
- **Synchronous guest→host calls.** Any exposed async functions appear synchronous within the guest code. The VM pauses and waits for host promises to resolve before resuming execution.
- **Deterministic execution limits.** Set memory limits, and bound execution duration by bytecode ops with 1K resolution.
- **Optional guest code pre-compilation.** MicroQuickJS doesn't support arrow functions or let/const, but you can use the built-in compiler to support some modern features.

## Install

```
npm install @okokoklol/mquickjs
```

## Quick start

```ts
import { MQuickJS } from "@okokoklol/mquickjs";

const engine = await MQuickJS.create();

const result = await engine.eval("1 + 1");
console.log(result); // 2

engine.dispose();
```

## Compile modern JS

MicroQuickJS runs a small ES5-era language. If you want to author guest code with modern syntax like arrow functions or `let` / `const`, use the compile API first.

### Node

```ts
import { compile } from "@okokoklol/mquickjs/compile";
import { MQuickJS } from "@okokoklol/mquickjs";

const engine = await MQuickJS.create();

const code = compile(`
  const add = (a, b) => a + b;
  add(3, 4);
`);

console.log(await engine.eval(code)); // 7
```

Install `@swc/core` alongside the package when you use this entrypoint:

```sh
npm install @okokoklol/mquickjs @swc/core
```

### Browser

```ts
import { compile } from "@okokoklol/mquickjs/compile/web";

const code = await compile("const add = (a, b) => a + b; add(3, 4);");
```

If you need to control SWC WASM loading yourself, call `init({ module })` first and then use `createCompileJS()` or `compile()`.

Install `@swc/wasm-web` alongside the package when you use this entrypoint:

```sh
npm install @okokoklol/mquickjs @swc/wasm-web
```

Both entrypoints reject syntax that still depends on runtime features MicroQuickJS does not provide, like async functions, generators, `await`, dynamic `import()`, and `import.meta`.

## API

### `MQuickJS.preload(options?)`

Pre-compile the WASM binary at module init time. Eliminates compilation latency from the first `create()` call. Safe to call multiple times.

```ts
// At the top of your server entry point
MQuickJS.preload();
```

### `MQuickJS.create(options?)`

Create a new sandbox instance. Returns a `Promise<MQuickJS>`.

```ts
const engine = await MQuickJS.create({
  memorySize: 65536,              // guest heap in bytes (default: 64KB)
  log: (msg) => console.log(msg), // guest print() handler
  locateFile: (path) => `/wasm/${path}`, // custom .wasm path
});
```

### `engine.eval(code, options?)`

Evaluate JavaScript in the sandbox. Returns the JSON-round-tripped result of the last expression. Throws on guest exceptions.

```ts
await engine.eval("2 + 2");             // 4
await engine.eval('"hello"');            // "hello"
await engine.eval("({a: 1, b: [2,3]})"); // {a: 1, b: [2, 3]}
```

Pass `fuel` to limit execution (see [Fuel](#fuel) below):

```ts
await engine.eval(untrustedCode, { fuel: 1_000_000 });
```

### `engine.expose(name, object)`

Expose a host object to the guest. Each property becomes a callable method inside the sandbox. Arguments and return values are JSON-serialized across the boundary.

```ts
await engine.expose("Env", {
  get: (key) => process.env[key] ?? null,
});

await engine.eval('Env.get("NODE_ENV")'); // "production"
```

### `engine.dispose()`

Free all resources. The instance is unusable after this.

## Host functions

### Sync

Synchronous handlers work as expected. The guest calls the function, the host returns a value, and the guest continues.

```ts
await engine.expose("Math2", {
  add: (a, b) => a + b,
  clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
});

await engine.eval("Math2.add(3, 4)"); // 7
```

### Async

Async handlers appear synchronous to the guest. When the guest calls a host function backed by an async handler, the WASM stack suspends (via Asyncify), the host awaits the Promise, and the guest resumes with the resolved value.

```ts
await engine.expose("Std", {
  fetch: async (url) => {
    const res = await fetch(url);
    return { status: res.status, body: await res.text() };
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

// Inside the sandbox, these look like plain synchronous calls:
await engine.eval(`
  var res = Std.fetch("https://api.example.com/data");
  var items = JSON.parse(res.body);
  Std.sleep(100);
`);
```

The guest is ES5-era JS — no Promises, no async/await. Use `@okokoklol/mquickjs/compile` or `@okokoklol/mquickjs/compile/web` if you want to author guest code in modern syntax.

## Fuel

Untrusted code can be limited with a deterministic execution budget. Fuel is measured in interpreter ticks (each tick ≈ 10,000 bytecode operations). When fuel runs out, the engine throws a guest-uncatchable `"interrupted"` exception.

```ts
// Plenty of fuel for simple expressions
await engine.eval("1 + 1", { fuel: 100_000 });

// Infinite loops get stopped
try {
  await engine.eval("while(true){}", { fuel: 100_000 });
} catch (e) {
  console.log(e.message); // "InternalError: interrupted"
}

// Engine recovers — next eval works fine
await engine.eval("2 + 2", { fuel: 100_000 });
```

Fuel is deterministic: the same code consumes the same fuel on every machine. Async host calls (Asyncify suspensions) do not consume fuel — only guest bytecode execution counts.

Omitting `fuel` means unlimited execution (backward compatible).

## Performance

The compiled WASM module is cached after first compilation. Subsequent `create()` calls reuse it.

| Operation | Latency |
|---|---|
| Cold start (compile WASM + init) | ~4ms |
| Warm create (cached module) | ~0.3ms |
| eval (primitives) | ~0.01ms |
| Sync host call round-trip | ~0.01ms |

Call `MQuickJS.preload()` at module init to move compilation off the critical path.

## Binary size

| | Raw | Gzip | Brotli |
|---|---|---|---|
| mquickjs.wasm | 268KB | 94KB | 86KB |

## Building from source

Requires [Emscripten](https://emscripten.org/) and a C compiler.

```
npm run build
```

## License

MIT
