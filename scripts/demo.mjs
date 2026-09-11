// One-terminal demo: starts the redeem module and the gateway together, prefixing each line with its source.
// Ctrl-C stops both. For separate terminals use `npm run module` and `npm run gateway`.
import { spawn } from "node:child_process";

const procs = [
  ["module ", "src/module.ts"],
  ["gateway", "src/gateway.ts"],
].map(([tag, file]) => {
  const p = spawn("npx", ["tsx", file], { stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (stream, sink) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) if (l.trim()) sink.write(`[${tag}] ${l}\n`);
    });
  };
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on("exit", (code) => {
    console.log(`[${tag}] exited (${code ?? "signal"}), stopping the other`);
    stop();
  });
  return p;
});

const stop = () => {
  for (const p of procs) if (p.exitCode === null) p.kill();
  setTimeout(() => process.exit(0), 200);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
