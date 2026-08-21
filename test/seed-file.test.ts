import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { buildGraph } from "../src/graph/build.js";
import { readSeedFile, writeSeedFile } from "../src/graph/seed-file.js";
import type { NodeV1 } from "../src/graph/types.js";

const node = (id: string, hash: string, summary: string | null, state = "ready") =>
  ({ id, name: id, kind: "function", path: "a.ts", span: "L1-L2", body_hash: hash,
     summary, summary_state: state, crux: null } as unknown as NodeV1);

test("a seed carries ready summaries and skips everything else", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-seed-"));
  try {
    const path = join(dir, "seed.ndjson.gz");
    const written = writeSeedFile(path, [
      node("a", "h1", "does a"),
      node("b", "h2", null),                    // nothing to say
      node("c", "h3", "stale text", "stale"),   // not ready
    ], {});
    assert.equal(written, 1, "only the ready summary travels");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt or truncated seed yields no entries instead of throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-seed-bad-"));
  try {
    const notGzip = join(dir, "a.gz");
    writeFileSync(notGzip, "this is not gzip");
    assert.equal((await readSeedFile(notGzip)).size, 0);

    const truncated = join(dir, "b.gz");
    writeFileSync(truncated, gzipSync(Buffer.from('{"v":1}\n{"i":"a","h":"h1","s":"ok"}\n{"i":"b","h"')));
    const partial = await readSeedFile(truncated);
    assert.equal(partial.size, 1, "entries before the damage are still usable");

    assert.equal((await readSeedFile(join(dir, "missing.gz"))).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a seed from a newer schema is refused rather than guessed at", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-seed-v-"));
  try {
    const p = join(dir, "future.gz");
    writeFileSync(p, gzipSync(Buffer.from('{"v":999}\n{"i":"a","h":"h1","s":"ok"}\n')));
    assert.equal((await readSeedFile(p)).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--seed-in supplies summaries a build never paid for, and only for matching code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-seed-build-"));
  try {
    writeFileSync(join(dir, "a.ts"), "export function alpha(): number {\n  return 1;\n}\n");
    await buildGraph(dir);
    const graphPath = join(dir, "graft", ".graph", "wiring.json");
    const built = JSON.parse(readFileSync(graphPath, "utf8")) as { nodes: NodeV1[] };
    const target = built.nodes.find((n) => n.name === "alpha")!;
    assert.equal(target.summary_state, "pending", "no LLM ran, so nothing is summarized yet");

    const seed = join(dir, "seed.ndjson.gz");
    writeSeedFile(seed, [
      { ...target, summary: "Answers the meaning of alpha.", summary_state: "ready" } as NodeV1,
      node("a.ts#ghost", "nope", "describes code that is not here"),
    ], {});

    const res = await buildGraph(dir, { seedIn: seed });
    assert.equal(res.seededSummaries, 1, "the matching node is adopted; the stranger is not");
    const after = JSON.parse(readFileSync(graphPath, "utf8")) as { nodes: NodeV1[] };
    const got = after.nodes.find((n) => n.name === "alpha")!;
    assert.equal(got.summary, "Answers the meaning of alpha.");
    assert.equal(got.summary_state, "ready");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a seed describing changed code is ignored, never applied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-seed-stale-"));
  try {
    writeFileSync(join(dir, "a.ts"), "export function beta(): number {\n  return 1;\n}\n");
    await buildGraph(dir);
    const graphPath = join(dir, "graft", ".graph", "wiring.json");
    const built = JSON.parse(readFileSync(graphPath, "utf8")) as { nodes: NodeV1[] };
    const target = built.nodes.find((n) => n.name === "beta")!;

    const seed = join(dir, "seed.ndjson.gz");
    writeSeedFile(seed, [
      { ...target, summary: "Describes the OLD body.", summary_state: "ready" } as NodeV1,
    ], {});

    // The body changes: the seed's hash no longer describes this code.
    writeFileSync(join(dir, "a.ts"), "export function beta(): number {\n  return 99;\n}\n");
    const res = await buildGraph(dir, { seedIn: seed });
    assert.equal(res.seededSummaries ?? 0, 0, "a summary is never attached to code it did not describe");
    const after = JSON.parse(readFileSync(graphPath, "utf8")) as { nodes: NodeV1[] };
    assert.notEqual(after.nodes.find((n) => n.name === "beta")!.summary, "Describes the OLD body.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
