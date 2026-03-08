import { MQuickJS } from "../dist/index.js";

async function bench(label, fn, iterations = 1) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  if (iterations === 1) {
    console.log(`  ${label}: ${avg.toFixed(2)}ms`);
  } else {
    console.log(`  ${label}: avg ${avg.toFixed(2)}ms, min ${min.toFixed(2)}ms (n=${iterations})`);
  }
  return avg;
}

async function run() {
  console.log("=== Cold start (first create, compiles WASM) ===");
  let engine;
  await bench("create", async () => { engine = await MQuickJS.create({ log: () => {} }); }, 1);
  engine.dispose();

  console.log("\n=== Warm create (cached WASM module) ===");
  await bench("create", async () => {
    const e = await MQuickJS.create({ log: () => {} });
    e.dispose();
  }, 10);

  console.log("\n=== Eval throughput (warm engine) ===");
  engine = await MQuickJS.create({ log: () => {} });

  await bench("int return (1+1)", () => engine.eval("1+1"), 1000);
  await bench("string return", () => engine.eval('"hello world"'), 1000);
  await bench("bool return", () => engine.eval("true"), 1000);
  await bench("null return", () => engine.eval("null"), 1000);
  await bench("object return", () => engine.eval('JSON.stringify({a:1,b:2})'), 1000);
  await bench("fibonacci(20)", () => engine.eval(
    "(function fib(n){return n<2?n:fib(n-1)+fib(n-2)})(20)"
  ), 100);

  console.log("\n=== Host call throughput ===");
  await engine.expose("Host", { add: (a, b) => a + b });
  await bench("sync host call", () => engine.eval("Host.add(3, 4)"), 1000);

  engine.dispose();
  console.log("\ndone");
}

run().catch(console.error);
