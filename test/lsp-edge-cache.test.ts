/**
 * The LSP edge memo. Enrichment is the one part of a build that is neither cheap
 * nor incremental — a full pass is one call-hierarchy round trip per callable
 * node — so a rebuild after a one-line edit must replay the edges of every file
 * that didn't move rather than re-derive them.
 *
 * The carry-forward path is exercised here without any language server
 * installed: seed the memo with edges between nodes that really exist, rebuild
 * with `lsp: true`, and assert they land in the graph. Nothing spawns, because
 * no file changed, which is precisely the property being tested.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import {
  emptyLspEdgeCache,
  lspCachePath,
  readLspEdgeCache,
  writeLspEdgeCache,
} from "../src/graph/lsp/edge-cache.js";
import type { EdgeV1 } from "../src/graph/types.js";

const SRC = `export function alpha(): number {
  return 1;
}

export function beta(): number {
  return alpha();
}
`;

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-lspmemo-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), SRC);
  return dir;
}

test("memo round-trips, and its identity invalidates it", () => {
  const dir = repo();
  try {
    const out = join(dir, "graft");
    mkdirSync(join(out, ".cache"), { recursive: true });
    assert.ok(lspCachePath(out), "a stamped path exists");

    const cache = emptyLspEdgeCache("dart");
    cache.files["src/a.ts"] = [
      { source: "src/a.ts#beta", target: "src/a.ts#alpha", relation: "calls", confidence: "lsp_resolved" } as EdgeV1,
    ];
    writeLspEdgeCache(out, cache);

    assert.deepEqual(readLspEdgeCache(out, "dart").files["src/a.ts"], cache.files["src/a.ts"]);
    // A different set of servers must not reuse the previous set's edges — a
    // server that stopped being installed would otherwise be frozen into the
    // graph with nothing left to correct it.
    assert.deepEqual(readLspEdgeCache(out, "clangd").files, {}, "server identity invalidates");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unchanged file replays its edges instead of re-querying", async () => {
  const dir = repo();
  try {
    const out = join(dir, "graft");
    // A first ordinary build, to get real node ids to point at.
    await buildGraph(dir, {});
    const before = readGraph(wiringPath(out))!;
    const ids = new Set(before.nodes.map((n) => n.id));
    const alpha = [...ids].find((i) => i.endsWith("#alpha"))!;
    const beta = [...ids].find((i) => i.endsWith("#beta"))!;
    assert.ok(alpha && beta, "both functions are in the graph");

    // alpha→beta is deliberately NOT a call the AST tier finds (beta calls alpha,
    // not the reverse), so a carried copy can't be confused with a real edge the
    // extractor would have produced anyway.
    const seeded = emptyLspEdgeCache("");
    seeded.files["src/a.ts"] = [
      { source: alpha, target: beta, relation: "calls", confidence: "lsp_resolved" } as EdgeV1,
      // A dangling edge: its target is not a node in this graph, so carrying it
      // forward would corrupt the graph with a reference to nothing.
      { source: alpha, target: "src/gone.ts#vanished", relation: "calls", confidence: "lsp_resolved" } as EdgeV1,
    ];
    writeLspEdgeCache(out, seeded);

    // Nothing changed on disk, so every file replays and no server is consulted.
    await buildGraph(dir, { lsp: true });
    const after = readGraph(wiringPath(out))!;

    const carried = after.edges.filter((e) => e.confidence === "lsp_resolved");
    assert.equal(carried.length, 1, "the live edge is carried, the dangling one dropped");
    assert.equal(carried[0].source, alpha);
    assert.equal(carried[0].target, beta);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cold build ignores the memo entirely", async () => {
  const dir = repo();
  try {
    const out = join(dir, "graft");
    await buildGraph(dir, {});
    const before = readGraph(wiringPath(out))!;
    const beta = before.nodes.find((n) => n.id.endsWith("#beta"))!.id;
    const alpha = before.nodes.find((n) => n.id.endsWith("#alpha"))!.id;

    const seeded = emptyLspEdgeCache("");
    seeded.files["src/a.ts"] = [
      { source: alpha, target: beta, relation: "calls", confidence: "lsp_resolved" } as EdgeV1,
    ];
    writeLspEdgeCache(out, seeded);

    // `--no-reuse` means "re-derive everything"; a memo that survived it would
    // make a cold build unable to correct a bad edge.
    await buildGraph(dir, { lsp: true, reuse: false });
    const after = readGraph(wiringPath(out))!;
    assert.equal(after.edges.filter((e) => e.confidence === "lsp_resolved").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replay-only keeps memoized edges and never consults a server", async () => {
  const dir = repo();
  try {
    const out = join(dir, "graft");
    await buildGraph(dir, {});
    const before = readGraph(wiringPath(out))!;
    const alpha = before.nodes.find((n) => n.id.endsWith("#alpha"))!.id;
    const beta = before.nodes.find((n) => n.id.endsWith("#beta"))!.id;

    const seeded = emptyLspEdgeCache("");
    seeded.files["src/a.ts"] = [
      { source: alpha, target: beta, relation: "calls", confidence: "lsp_resolved" } as EdgeV1,
    ];
    writeLspEdgeCache(out, seeded);

    // Change the file, so a querying build would have to re-derive its edges.
    writeFileSync(join(dir, "src", "a.ts"), SRC + "\nexport function gamma(): number { return beta(); }\n");

    await buildGraph(dir, { lspReplayOnly: true });
    const after = readGraph(wiringPath(out))!;

    // The edge belonged to the file that changed, so it is not replayed into the
    // graph — but it is also not erased from the memo, because nothing
    // re-derived it. The next explicit --lsp build is what replaces it.
    assert.ok(after.nodes.some((n) => n.id.endsWith("#gamma")), "the new definition is indexed");
    assert.deepEqual(readLspEdgeCache(out, "").files["src/a.ts"], seeded.files["src/a.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replay-only replays an unchanged file's edges", async () => {
  const dir = repo();
  try {
    const out = join(dir, "graft");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "b.ts"), "export function other(): number { return 2; }\n");
    await buildGraph(dir, {});
    const before = readGraph(wiringPath(out))!;
    const alpha = before.nodes.find((n) => n.id.endsWith("#alpha"))!.id;
    const beta = before.nodes.find((n) => n.id.endsWith("#beta"))!.id;

    const seeded = emptyLspEdgeCache("");
    seeded.files["src/a.ts"] = [
      { source: alpha, target: beta, relation: "calls", confidence: "lsp_resolved" } as EdgeV1,
    ];
    writeLspEdgeCache(out, seeded);

    // Touch a DIFFERENT file: a.ts is unchanged, so its edges must survive.
    writeFileSync(join(dir, "src", "b.ts"), "export function other(): number { return 3; }\n");

    await buildGraph(dir, { lspReplayOnly: true });
    const after = readGraph(wiringPath(out))!;
    const carried = after.edges.filter((e) => e.confidence === "lsp_resolved");
    assert.equal(carried.length, 1, "the untouched file's edge survived the refresh");
    assert.equal(carried[0].source, alpha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
