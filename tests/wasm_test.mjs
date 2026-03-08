import { compile } from "../dist/compile.js";
import { MQuickJS } from "../dist/index.js";

async function run() {
  const engine = await MQuickJS.create();

  // Compile modern syntax to guest-safe ES3 first.
  const compiled = compile("const add = (a, b) => a + b; add(3, 4);");
  console.log("compiled add =", await engine.eval(compiled));

  // Basic eval
  console.log("1+1 =", await engine.eval("1+1"));

  // Console output
  await engine.eval('print("hello from guest")');

  // Sync host call
  await engine.expose("Math2", {
    add: (a, b) => a + b,
    mul: (a, b) => a * b,
  });
  console.log("Math2.add(3,4) =", await engine.eval("Math2.add(3, 4)"));
  console.log("Math2.mul(5,6) =", await engine.eval("Math2.mul(5, 6)"));

  // Async host call
  await engine.expose("Std", {
    fetch: async (url) => {
      const res = await fetch(url);
      return { status: res.status, body: await res.text() };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });

  console.log("--- async fetch ---");
  const fetchResult = await engine.eval(
    'var r = Std.fetch("https://httpbin.org/get"); r.status'
  );
  console.log("fetch status =", fetchResult);

  console.log("--- async sleep ---");
  const t0 = Date.now();
  await engine.eval("Std.sleep(200)");
  console.log(`slept ${Date.now() - t0}ms`);

  // Error handling
  try {
    await engine.eval("throw new Error('boom')");
  } catch (e) {
    console.log("caught:", e.message);
  }

  engine.dispose();
  console.log("done");
}

run().catch(console.error);
