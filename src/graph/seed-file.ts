/**
 * The meaning layer as a portable file — one machine's summaries, usable by any
 * other checkout of the same repo.
 *
 * Tier-2 summaries cost real money and real time, and they are identical for
 * everyone: each is keyed by a hash of the code it describes, so the same commit
 * yields the same text on any machine. Yet `buildGraph` could only ever reuse
 * summaries from a graph it had written itself, which meant every engineer paid
 * the whole bill again or went without. This is the file that lets one run pay
 * for all of them — written by `--seed-out`, folded in by `--seed-in`.
 *
 * Deliberately NOT the graph: spans, edges and cards are a set of `file:line`
 * facts about one working tree, and they rebuild locally in seconds. Carrying
 * them would multiply the artifact by an order of magnitude to ship data the
 * receiver is going to recompute anyway.
 *
 * Newline-delimited JSON, gzipped: a header line, then one line per summarized
 * node. NDJSON so a reader can stream rather than materialize the whole thing,
 * and so two seeds diff line by line.
 */
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip, gzipSync } from "node:zlib";
import type { Crux, NodeV1 } from "./types.js";

/** Bumped only when a reader could misread an older file. */
export const SEED_SCHEMA = 1;

export interface SeedHeader {
  v: number;
  graft?: string;
  repo?: string;
  generated?: string;
  nodes?: number;
}

/** One node's meaning, and the body hash that says which code it describes. */
export interface SeedEntry {
  i: string;
  h: string;
  s: string;
  c?: Crux | null;
}

/** Serialize every ready summary in `nodes`. Nodes without one are skipped:
 * absence is the receiver's default already, so shipping it says nothing. */
export function writeSeedFile(path: string, nodes: readonly NodeV1[], header: Omit<SeedHeader, "v">): number {
  const lines: string[] = [];
  let count = 0;
  for (const n of nodes) {
    if (n.summary_state !== "ready" || !n.summary || !n.body_hash) continue;
    const entry: SeedEntry = { i: n.id, h: n.body_hash, s: n.summary };
    if (n.crux) entry.c = n.crux;
    lines.push(JSON.stringify(entry));
    count++;
  }
  const head: SeedHeader = { v: SEED_SCHEMA, generated: new Date().toISOString(), ...header, nodes: count };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(Buffer.from(`${JSON.stringify(head)}\n${lines.join("\n")}\n`)));
  return count;
}

/**
 * Read a seed into a map keyed by node id.
 *
 * Never throws. A seed is an optimization: a missing, truncated or corrupt one
 * must cost summaries, never the build. A caller that cannot tell the difference
 * between "no seed" and "bad seed" is fine here — both mean the same thing to
 * the build, and the caller reports the count it actually folded.
 */
export async function readSeedFile(path: string): Promise<Map<string, SeedEntry>> {
  const out = new Map<string, SeedEntry>();
  // A stream over a missing path reports the failure asynchronously, after the
  // iterator has already been handed back — outside the reach of the try below.
  if (!existsSync(path)) return out;
  try {
    const stream = createReadStream(path);
    // Same reason: an unhandled 'error' on the source is a process-level crash,
    // not something the pipeline's consumer can catch.
    stream.on("error", () => {});
    const rl = createInterface({ input: stream.pipe(createGunzip()), crlfDelay: Infinity });
    let first = true;
    for await (const line of rl) {
      if (!line) continue;
      if (first) {
        first = false;
        // A schema this reader predates could mean anything; refuse the file
        // rather than guess at entries whose shape may have changed.
        const head = JSON.parse(line) as SeedHeader;
        if (typeof head.v !== "number" || head.v > SEED_SCHEMA) return new Map();
        continue;
      }
      const e = JSON.parse(line) as SeedEntry;
      if (typeof e.i === "string" && typeof e.h === "string" && typeof e.s === "string") out.set(e.i, e);
    }
  } catch {
    return out; // whatever parsed before the failure is still usable
  }
  return out;
}
