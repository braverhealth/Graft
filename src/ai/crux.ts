/**
 * Tier-2 "meaning" call for the code graph — batched one request per file.
 *
 * Given a source file (with 1-based line numbers) and the list of definitions in
 * it, one call returns, for each definition:
 *   1. `summary` — one plain-English sentence: what the symbol is *for*, at the
 *      business-logic level, not a restatement of its signature.
 *   2. `crux_start`/`crux_end` — the smallest contiguous range of FILE line
 *      numbers (inside that symbol's own span) that a reviewer must read to see
 *      the decision or rule the code encodes. `0/0` means there is no single
 *      crux (a trivial getter, a plain data holder).
 *
 * Batching per file means N definitions cost one request, not N — and the model
 * sees each symbol's neighbours, which sharpens the summaries. Line numbers are
 * consumed once, at write time, to slice the crux text verbatim from source.
 */
import type { ChatModel } from "./llm/types.js";
import type { Kind } from "../graph/types.js";

/** One definition we want described, located by its line span within the file. */
export interface NodeRef {
  id: string;
  kind: Kind;
  signature: string | null;
  startLine: number; // 1-based file line where the definition starts
  endLine: number;
}

export interface FileCruxInput {
  path: string;
  source: string;
  nodes: NodeRef[];
}

export interface NodeCrux {
  id: string;
  summary: string;
  crux_start: number; // file line, within the symbol's span; 0 = no distinct crux
  crux_end: number;
}

export interface CruxSummarizer {
  describeFile(input: FileCruxInput): Promise<NodeCrux[]>;
}

const SYSTEM_PROMPT = `You explain code definitions for a code graph that helps engineers navigate a codebase.

You are given ONE source file with 1-based line numbers, and a list of TARGET definitions in it. Describe EVERY target via the record_symbols tool.

Rules:
- Return EXACTLY ONE entry for EVERY target id, using that id verbatim: the id is the text following 'id=' to the END of that target's line, and nothing else. The number of entries you return MUST equal the number of targets. Never omit a target: a reply missing any id is invalid and will be re-requested.
- A trivial symbol is NOT an exception. You still return it — with a one-sentence summary and crux 0/0 (see below). "Skip" means "give it no crux span", NEVER "leave it out".
- summary: ONE sentence — what the symbol is FOR at the business-logic level (the problem it solves or the rule it enforces), not a restatement of its signature.
- crux_start / crux_end: FILE line numbers (as shown), inside that symbol's own line range. Pick the SINGLE most important contiguous span — the core branch, formula, guard, or state change — at most ~8 lines, and NEVER the whole function. When there is no single focal span (a trivial getter, a plain data holder, a one-line delegation, or logic spread evenly), use crux_start: 0 and crux_end: 0. That 0/0 IS the answer — do not drop the entry.`;

const RECORD_TOOL = "record_symbols";

const SYMBOLS_SCHEMA = {
  type: "object",
  properties: {
    symbols: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          summary: { type: "string" },
          crux_start: { type: "number" },
          crux_end: { type: "number" },
        },
        required: ["id", "summary", "crux_start", "crux_end"],
      },
    },
  },
  required: ["symbols"],
} as const;

/** Cap the file text sent per request so one huge file can't blow the context. */
const MAX_CODE_CHARS = 18_000;

/**
 * The file text a batch needs, as the lines its own targets occupy.
 *
 * Sending the head of the file and asking about a symbol defined past the cut
 * gets one of two answers, and the worse one is silent: the model either says
 * it cannot find the symbol, or writes a confident summary — with line numbers —
 * for code it was never shown. Windowing per batch means every target asked
 * about is present in the text accompanying the question. Line numbers stay
 * absolute so the crux spans still index the real file.
 */
function numberLines(source: string, from: number, to: number): string {
  const lines = source.split("\n");
  const start = Math.max(1, Math.min(from, lines.length));
  const end = Math.min(lines.length, Math.max(to, start));
  let out = "";
  let truncated = false;
  for (let i = start; i <= end; i++) {
    const next = `${i}\t${lines[i - 1] ?? ""}\n`;
    if (out.length + next.length > MAX_CODE_CHARS) {
      truncated = true;
      break;
    }
    out += next;
  }
  const header = start > 1 ? `… (file continues above; lines ${start}-${end} shown)\n` : "";
  return header + out + (truncated ? "… (truncated)" : "");
}

/** The line range a batch's targets span, so the window covers all of them. */
function windowFor(nodes: NodeRef[]): { from: number; to: number } {
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const n of nodes) {
    from = Math.min(from, n.startLine);
    to = Math.max(to, n.endLine);
  }
  return { from: Number.isFinite(from) ? from : 1, to };
}

/** Rendered length of each numbered line, as a prefix sum for O(1) windows. */
function lineCostPrefix(source: string): number[] {
  const lines = source.split("\n");
  const prefix = new Array<number>(lines.length + 1);
  prefix[0] = 0;
  for (let i = 1; i <= lines.length; i++) {
    prefix[i] = prefix[i - 1] + `${i}\t${lines[i - 1] ?? ""}\n`.length;
  }
  return prefix;
}

/**
 * Group targets into calls whose source window actually fits the budget.
 *
 * Capping a batch by target count alone is not enough: twenty large definitions
 * can span more source than one request may carry, and the surplus is then cut
 * from the text while still being asked about — the model answers for code it
 * cannot see. Batching on both counts keeps every target visible in its own
 * request. A single definition bigger than the whole budget still gets clipped,
 * but it travels alone, so it is the only symbol its truncation can affect.
 */
function batchTargets(nodes: NodeRef[], source: string): NodeRef[][] {
  const prefix = lineCostPrefix(source);
  const lastLine = prefix.length - 1;
  const charsFor = (batch: NodeRef[]): number => {
    const { from, to } = windowFor(batch);
    const start = Math.max(1, Math.min(from, lastLine));
    const end = Math.min(lastLine, Math.max(to, start));
    return prefix[end] - prefix[start - 1];
  };
  const ordered = [...nodes].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const batches: NodeRef[][] = [];
  let current: NodeRef[] = [];
  for (const node of ordered) {
    if (current.length === 0) {
      current = [node];
      continue;
    }
    const grown = [...current, node];
    if (grown.length > MAX_TARGETS_PER_CALL || charsFor(grown) > MAX_CODE_CHARS) {
      batches.push(current);
      current = [node];
    } else {
      current = grown;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function userContent(input: FileCruxInput): string {
  const targets = input.nodes
    .map(
      // `id=` runs to end of line, so the id goes LAST. With it in front, a
      // model copies the whole line — kind and line range included — as the id,
      // and every entry then fails to match the symbol it describes.
      (n) =>
        `- ${n.kind} | lines L${n.startLine}-L${n.endLine}` +
        (n.signature ? ` | ${n.signature}` : "") +
        ` | id=${n.id}`,
    )
    .join("\n");
  const n = input.nodes.length;
  const { from, to } = windowFor(input.nodes);
  return `FILE: ${input.path}\n\n${numberLines(input.source, from, to)}\n\nTARGETS (${n} — return all ${n}, one entry per id):\n${targets}`;
}

/** Normalize the tool's parsed argument object into a {@link NodeCrux} list. */
function parseResults(obj: { symbols?: unknown } | undefined): NodeCrux[] {
  if (!obj || !Array.isArray(obj.symbols)) return [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
  return obj.symbols
    .map((s) => s as Record<string, unknown>)
    .filter((s) => typeof s.id === "string")
    .map((s) => ({
      id: s.id as string,
      summary: typeof s.summary === "string" ? s.summary.trim() : "",
      crux_start: num(s.crux_start),
      crux_end: num(s.crux_end),
    }));
}

/**
 * Gemini rejects a forced tool call outright once the target list grows past
 * roughly 30 entries: it answers 200 with `MALFORMED_FUNCTION_CALL`, no tool
 * call, zero completion tokens, and no error to catch — so every symbol in the
 * file silently stays `pending`. Twenty is the largest batch measured to hold.
 * The file source is identical across a file's batches, so prompt caching makes
 * the extra requests far cheaper than their token counts suggest.
 */
const MAX_TARGETS_PER_CALL = 20;

/**
 * Map each returned entry back onto the id it was asked about.
 *
 * An unmatched id costs the symbol its summary silently — it simply stays
 * `pending`, indistinguishable from one nothing was written for. Models do
 * decorate ids with the surrounding target text, so an entry whose id starts
 * with a real id followed by the ` | ` field separator is recovered rather
 * than dropped. Anything still unrecognised is discarded: a summary attached
 * to the wrong symbol is worse than a missing one.
 */
function reconcileIds(entries: NodeCrux[], nodes: NodeRef[]): NodeCrux[] {
  const known = new Set(nodes.map((n) => n.id));
  const out: NodeCrux[] = [];
  for (const e of entries) {
    if (known.has(e.id)) {
      out.push(e);
      continue;
    }
    const head = e.id.split(" | ")[0].trim();
    if (known.has(head)) out.push({ ...e, id: head });
  }
  return out;
}

/** Crux summarizer backed by any {@link ChatModel} via forced tool calling. */
export class ChatCruxSummarizer implements CruxSummarizer {
  constructor(private model: ChatModel) {}

  async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
    if (input.nodes.length === 0) return [];
    const out: NodeCrux[] = [];
    let refused = 0;
    for (const batch of batchTargets(input.nodes, input.source)) {
      const got = await this.describeBatch({ ...input, nodes: batch });
      if (got === null) refused++;
      else out.push(...got);
    }
    // A refusal carries no error of its own, so a file that produced nothing at
    // all would otherwise land as "pending" and read exactly like a file with
    // nothing worth summarizing. Raise it here; partial results still stand.
    if (out.length === 0 && refused > 0) {
      throw new Error(`model returned no tool call for ${refused} batch(es)`);
    }
    return out;
  }

  /** Parsed entries, or null when the model answered without a tool call at all. */
  private async describeBatch(input: FileCruxInput): Promise<NodeCrux[] | null> {
    const res = await this.model.create({
      temperature: 0,
      maxTokens: 8192,
      tools: [
        {
          name: RECORD_TOOL,
          description: "Record each target definition's purpose and crux line range.",
          parameters: SYMBOLS_SCHEMA as unknown as Record<string, unknown>,
        },
      ],
      responseFormat: { kind: "tool", name: RECORD_TOOL },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent(input) },
      ],
    });
    if (res.toolCalls.length === 0) return null;
    const parsed = parseResults(res.toolCalls[0]?.args as { symbols?: unknown } | undefined);
    return reconcileIds(parsed, input.nodes);
  }
}
