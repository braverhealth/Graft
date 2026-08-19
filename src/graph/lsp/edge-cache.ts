/**
 * Per-file memo for LSP-resolved call edges — `<outDir>/.cache/lsp.<stamp>.json`.
 *
 * The enrichment tier is the one part of a build that is neither cheap nor
 * incremental: it asks a language server for the outgoing calls of every callable
 * node, which on a large Flutter monorepo is ~78,000 call-hierarchy round trips
 * and about five minutes. Tier-1 has been incremental since the extraction memo
 * landed, so a rebuild after one edit re-parses one file — and then, with `--lsp`
 * persisted, paid five minutes to re-derive edges for 12,654 files that had not
 * moved. That is the gap this closes.
 *
 * The unit of reuse is the *source* file of an edge, because that is what the
 * query is keyed on: `outgoingCalls` for the nodes defined in file F yields
 * exactly the edges whose source lives in F. If F's bytes haven't moved, its
 * edges are still whatever the server said last time, so they can be replayed and
 * F skipped.
 *
 * Two things are deliberately NOT claimed:
 *
 * - **Replayed edges are pruned against the current graph.** An edge whose source
 *   or target node no longer exists is dropped rather than carried, because a
 *   *different* file changing can remove the node this file pointed at.
 * - **A file that didn't change can still have stale edges.** If a new file adds
 *   a definition that an untouched caller now resolves to, only that caller being
 *   re-queried would notice, and it isn't. A periodic full `graft build --lsp`
 *   (which is what `--no-reuse` already forces) settles it. The alternative —
 *   re-querying the transitive callers of every changed file — costs most of the
 *   full pass to fix a case that a later edit to the caller fixes anyway.
 *
 * Same invalidation contract as the extraction memo: a shape change bumps
 * {@link CACHE_VERSION}, a change to the extractor moves {@link extractorStamp},
 * and a change to which servers ran moves the `servers` field. The stamp is in
 * the filename so two grafts on one repo keep separate memos.
 */
import { join } from "node:path";
import { CACHE_DIR } from "../../context/node-file.js";
import { readJson, writeJsonAtomic } from "../../util/state.js";
import { extractorStamp } from "../extract-cache.js";
import type { EdgeV1 } from "../types.js";

/** Bump when the on-disk shape below changes. */
const CACHE_VERSION = 2;
export const LSP_CACHE_PREFIX = "lsp";

export interface LspEdgeCache {
  version: number;
  /** Identity of the extractor that produced the nodes these edges point at.
   * Recorded for diagnosis only — it deliberately does NOT invalidate the memo,
   * because an edge describes a relationship in the SOURCE. See readLspEdgeCache. */
  extractor: string;
  /** Which servers produced these edges; a different set invalidates the memo. */
  servers: string;
  /** repo-relative path of an edge's SOURCE file → the last few answers the
   * server gave for it, newest first, each tagged with the content hash it was
   * derived from.
   *
   * More than one, because switching branches switches files back as often as it
   * switches them forward: reviewing a PR and returning to your own branch puts
   * every file back to bytes that were already asked about. Keeping one answer
   * per file made that return trip pay the full query pass again. */
  files: Record<string, LspFileEntry[]>;
}

export interface LspFileEntry {
  /** sha256 of the source file when these edges were derived. */
  hash: string;
  edges: EdgeV1[];
}

/** Answers kept per file. Three covers the common shuttle — your branch, the
 * one you are reviewing, and main — without turning the memo into a log. */
export const MAX_GENERATIONS = 3;

/** Put `entry` at the front of a file's history, replacing any answer for the
 * same content, and drop the oldest beyond {@link MAX_GENERATIONS}. */
export function rememberGeneration(
  files: Record<string, LspFileEntry[]>,
  rel: string,
  entry: LspFileEntry,
): void {
  const rest = (files[rel] ?? []).filter((g) => g.hash !== entry.hash);
  files[rel] = [entry, ...rest].slice(0, MAX_GENERATIONS);
}

/** The stored answer for this file's current content, if it was ever asked. */
export function generationFor(
  files: Record<string, LspFileEntry[]>,
  rel: string,
  hash: string | undefined,
): LspFileEntry | undefined {
  if (!hash) return undefined;
  return (files[rel] ?? []).find((g) => g.hash === hash);
}

export function emptyLspEdgeCache(servers = ""): LspEdgeCache {
  return { version: CACHE_VERSION, extractor: extractorStamp() ?? "", servers, files: {} };
}

/** Null stamp → null path → no memo, exactly as the extraction memo behaves. */
export function lspCachePath(outDir: string): string | null {
  const stamp = extractorStamp();
  return stamp === null ? null : join(outDir, CACHE_DIR, `${LSP_CACHE_PREFIX}.${stamp}.json`);
}

/** The memo for `servers`, or an empty one when anything about its identity
 * differs. Never throws: a cache that can't be read is a cache miss. */
export function readLspEdgeCache(outDir: string, servers: string): LspEdgeCache {
  const path = lspCachePath(outDir);
  if (!path) return emptyLspEdgeCache(servers);
  const raw = readJson<LspEdgeCache>(path);
  if (!raw || raw.version !== CACHE_VERSION) return emptyLspEdgeCache(servers);
  // NOT invalidated by a change of extractor. An LSP edge states that one span
  // of source calls another, which upgrading graft does not alter; what would
  // alter it is the file changing, and every entry carries the hash that catches
  // that. Keying on the extractor instead meant every version bump threw away
  // the whole memo and paid the full pass again — on a large repo, minutes per
  // upgrade, which is the cost a team actually feels. Endpoints that no longer
  // exist are pruned when the entry is replayed.
  // A server that stopped being installed would otherwise leave its edges in the
  // graph forever, with nothing left to re-derive or correct them.
  if (raw.servers !== servers) return emptyLspEdgeCache(servers);
  return { ...raw, files: raw.files ?? {} };
}

export function writeLspEdgeCache(outDir: string, cache: LspEdgeCache): void {
  const path = lspCachePath(outDir);
  if (!path) return;
  try {
    writeJsonAtomic(path, cache, true);
  } catch {
    /* a cache write failure costs the next build time, not correctness */
  }
}
