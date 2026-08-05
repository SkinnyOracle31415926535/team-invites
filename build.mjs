import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const client = join(dist, "client");
const ignored = new Set([".git", "dist", "node_modules", ".wrangler", ".openai", "drizzle", "tests"]);

await rm(dist, { recursive: true, force: true });
await mkdir(client, { recursive: true });
for (const entry of await readdir(root)) {
  if (ignored.has(entry)) continue;
  await cp(join(root, entry), join(client, entry), { recursive: true });
}
await mkdir(join(dist, "server"), { recursive: true });
await cp(join(root, "worker", "index.js"), join(dist, "server", "index.js"));
await mkdir(join(dist, ".openai"), { recursive: true });
await cp(join(root, ".openai", "hosting.json"), join(dist, ".openai", "hosting.json"));
await cp(join(root, "drizzle"), join(dist, ".openai", "drizzle"), { recursive: true });
