/**
 * The three engine ops (summarize / synthesize / crux) over a fake transport —
 * proves each builds the right ChatRequest and parses the response, with no key
 * and no network. Structured ops (synthesize, crux) ride forced tool-calling;
 * summarize is plain text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatSummarizer } from "../src/ai/summarize.js";
import { ChatSynthesizer } from "../src/ai/synthesize.js";
import { ChatCruxSummarizer } from "../src/ai/crux.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall } from "../src/ai/llm/types.js";

/** Records the last request and replays a canned response. */
class FakeChatModel implements ChatModel {
  readonly label = "fake:model";
  last?: ChatRequest;
  constructor(private reply: { text?: string; toolCalls?: ToolCall[] }) {}
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.last = req;
    return {
      text: this.reply.text ?? "",
      toolCalls: this.reply.toolCalls ?? [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: "stop",
      assistant: { role: "assistant", content: this.reply.text ?? "" },
    };
  }
}

test("ChatSummarizer sends plain text and returns trimmed content", async () => {
  const m = new FakeChatModel({ text: "  a prose summary  " });
  const out = await new ChatSummarizer(m).summarize("code", { path: "a.ts" });
  assert.equal(out, "a prose summary");
  assert.equal(m.last?.responseFormat, undefined); // plain text
  assert.equal(m.last?.messages[0].role, "system");
});

test("ChatSynthesizer forces record_graph and cleans parsed args", async () => {
  const m = new FakeChatModel({
    toolCalls: [
      {
        id: "1",
        name: "record_graph",
        args: { nodes: [{ name: "Auth", type: "system", summary: "s", sources: ["a.ts"], links: [] }] },
      },
    ],
  });
  const nodes = await new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]);
  assert.deepEqual(m.last?.responseFormat, { kind: "tool", name: "record_graph" });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Auth");
});

test("ChatCruxSummarizer forces record_symbols and normalizes numbers", async () => {
  const m = new FakeChatModel({
    toolCalls: [
      { id: "1", name: "record_symbols", args: { symbols: [{ id: "sym1", summary: "does x", crux_start: 3.9, crux_end: 5 }] } },
    ],
  });
  const out = await new ChatCruxSummarizer(m).describeFile({
    path: "a.ts",
    source: "l1\nl2\nl3\nl4\nl5\n",
    nodes: [{ id: "sym1", kind: "function", signature: null, startLine: 1, endLine: 5 }],
  });
  assert.deepEqual(m.last?.responseFormat, { kind: "tool", name: "record_symbols" });
  assert.deepEqual(out, [{ id: "sym1", summary: "does x", crux_start: 3, crux_end: 5 }]);
});

test("structured ops degrade gracefully when the model returns no tool call", async () => {
  const empty = new FakeChatModel({ toolCalls: [] });
  assert.deepEqual(await new ChatSynthesizer(empty).synthesize([{ path: "a.ts", summary: "x" }]), []);
});

test("ChatCruxSummarizer raises when a file yields no tool call at all", async () => {
  // Silence here is indistinguishable from "nothing worth summarizing", which
  // let a provider refusing every request read as a clean build.
  const empty = new FakeChatModel({ toolCalls: [] });
  await assert.rejects(
    new ChatCruxSummarizer(empty).describeFile({
      path: "a.ts",
      source: "x",
      nodes: [{ id: "s", kind: "function", signature: null, startLine: 1, endLine: 1 }],
    }),
    /no tool call/,
  );
});

test("ChatCruxSummarizer splits large target lists across calls", async () => {
  // Gemini answers a 40-target request with MALFORMED_FUNCTION_CALL and no tool
  // call, so batches stay small enough for every provider to answer.
  const nodes = Array.from({ length: 45 }, (_, i) => ({
    id: `s${i}`,
    kind: "function" as const,
    signature: null,
    startLine: 1,
    endLine: 1,
  }));
  const batches: number[] = [];
  const model: ChatModel = {
    label: "fake:batching",
    async create(req) {
      const ids = [...String(req.messages[1].content).matchAll(/\| id=(.+)$/gm)].map((m) => m[1]);
      batches.push(ids.length);
      return {
        text: "",
        toolCalls: [
          {
            id: "1",
            name: "record_symbols",
            args: {
              symbols: ids.map((id) => ({ id, summary: "s", crux_start: 0, crux_end: 0 })),
            },
          },
        ],
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        stopReason: "stop" as const,
        assistant: { role: "assistant" as const, content: "" },
      };
    },
  };
  const out = await new ChatCruxSummarizer(model).describeFile({
    path: "a.ts",
    source: "x",
    nodes,
  });
  assert.deepEqual(batches, [20, 20, 5]);
  assert.equal(out.length, 45);
});

test("ChatCruxSummarizer puts the id last and recovers decorated ids", async () => {
  // `id=` runs to end of line; with the id in front, models copy the whole
  // target line as the id and every entry silently fails to match its symbol.
  let sent = "";
  const model: ChatModel = {
    label: "fake:ids",
    async create(req) {
      sent = String(req.messages[1].content);
      return {
        text: "",
        toolCalls: [
          {
            id: "1",
            name: "record_symbols",
            args: {
              symbols: [
                { id: "a.ts#f | function | lines L1-L2", summary: "decorated", crux_start: 0, crux_end: 0 },
                { id: "a.ts#g", summary: "clean", crux_start: 0, crux_end: 0 },
                { id: "a.ts#nope", summary: "invented", crux_start: 0, crux_end: 0 },
              ],
            },
          },
        ],
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        stopReason: "stop" as const,
        assistant: { role: "assistant" as const, content: "" },
      };
    },
  };
  const mk = (id: string) => ({ id, kind: "function" as const, signature: null, startLine: 1, endLine: 2 });
  const out = await new ChatCruxSummarizer(model).describeFile({
    path: "a.ts",
    source: "l1\nl2\n",
    nodes: [mk("a.ts#f"), mk("a.ts#g")],
  });
  assert.match(sent, /\| id=a\.ts#f$/m);
  assert.deepEqual(out.map((o) => o.id).sort(), ["a.ts#f", "a.ts#g"]);
});

test("ChatCruxSummarizer keeps every target inside the source window it sends", async () => {
  // Twenty large definitions span more source than one request carries; capping
  // on count alone cut the surplus from the text while still asking about it,
  // and the model answered for code it could not see.
  const body = `${"x".repeat(200)}\n`.repeat(400); // 400 lines, ~80k chars
  const source = body;
  const nodes = Array.from({ length: 12 }, (_, i) => ({
    id: `s${i}`,
    kind: "function" as const,
    signature: null,
    startLine: i * 30 + 1,
    endLine: i * 30 + 30,
  }));
  const windows: Array<{ ids: string[]; lines: number[] }> = [];
  const model: ChatModel = {
    label: "fake:window",
    async create(req) {
      const text = String(req.messages[1].content);
      const ids = [...text.matchAll(/\| id=(.+)$/gm)].map((m) => m[1]);
      const lines = [...text.matchAll(/^(\d+)\t/gm)].map((m) => Number(m[1]));
      windows.push({ ids, lines });
      return {
        text: "",
        toolCalls: [
          { id: "1", name: "record_symbols",
            args: { symbols: ids.map((id) => ({ id, summary: "s", crux_start: 0, crux_end: 0 })) } },
        ],
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        stopReason: "stop" as const,
        assistant: { role: "assistant" as const, content: "" },
      };
    },
  };
  const out = await new ChatCruxSummarizer(model).describeFile({ path: "big.ts", source, nodes });
  assert.ok(windows.length > 1, "12 large targets must not ride in a single call");
  for (const w of windows) {
    const shown = new Set(w.lines);
    for (const id of w.ids) {
      const n = nodes.find((x) => x.id === id)!;
      assert.ok(shown.has(n.startLine), `${id} asked about but line ${n.startLine} not sent`);
      assert.ok(shown.has(n.endLine), `${id} asked about but line ${n.endLine} not sent`);
    }
  }
  assert.equal(out.length, nodes.length);
});
