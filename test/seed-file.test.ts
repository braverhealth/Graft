import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
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
    assert.equal((await readSeedFile(notGzip)).nodes.size, 0);

    const truncated = join(dir, "b.gz");
    writeFileSync(truncated, gzipSync(Buffer.from('{"v":1}\n{"i":"a","h":"h1","s":"ok"}\n{"i":"b","h"')));
    const partial = (await readSeedFile(truncated)).nodes;
    assert.equal(partial.size, 1, "entries before the damage are still usable");

    assert.equal((await readSeedFile(join(dir, "missing.gz"))).nodes.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a seed from a newer schema is refused rather than guessed at", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-seed-v-"));
  try {
    const p = join(dir, "future.gz");
    writeFileSync(p, gzipSync(Buffer.from('{"v":999}\n{"i":"a","h":"h1","s":"ok"}\n')));
    assert.equal((await readSeedFile(p)).nodes.size, 0);
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

test("the concepts cache travels with the seed, and local entries win", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-seed-ctx-"));
  try {
    const path = join(dir, "seed.ndjson.gz");
    writeSeedFile(path, [node("a", "h1", "does a")], {}, {
      summaries: { "docs/a.md": { hash: "fh1", summary: "prose about a" } },
      synth: { batch1: [{ name: "Concept" }] },
    });
    const { nodes, context } = await readSeedFile(path);
    assert.equal(nodes.size, 1, "node summaries still travel");
    assert.deepEqual(context.summaries["docs/a.md"], { hash: "fh1", summary: "prose about a" });
    assert.deepEqual(context.synth.batch1, [{ name: "Concept" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reader that predates the file layer still gets every node summary", async () => {
  // Old readers skip records they cannot parse as node entries, so publishing a
  // seed with the concepts layer must not strip summaries from installs behind.
  const dir = mkdtempSync(join(tmpdir(), "graft-seed-compat-"));
  try {
    const path = join(dir, "seed.ndjson.gz");
    writeSeedFile(path, [node("a", "h1", "does a"), node("b", "h2", "does b")], {}, {
      summaries: { "docs/a.md": { hash: "fh1", summary: "prose" } },
      synth: {},
    });
    const lines = gunzipSync(readFileSync(path)).toString().trim().split("\n");
    const asOldReader = new Map<string, unknown>();
    for (const line of lines.slice(1)) {
      const e = JSON.parse(line) as { i?: string; h?: string; s?: string };
      if (typeof e.i === "string" && typeof e.h === "string" && typeof e.s === "string") asOldReader.set(e.i, e);
    }
    assert.deepEqual([...asOldReader.keys()].sort(), ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
