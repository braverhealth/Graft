/**
 * LSP server registry — maps graft language names to a language server command.
 * Only servers whose binary is actually on PATH are eligible; a missing binary
 * simply means that language gets no LSP enrichment (the AST graph stands alone).
 */
import { execSync } from "node:child_process";

export interface LspServer {
  /** graft language names (as produced by languageLabelOf/genericLangOf) this serves. */
  languages: string[];
  command: string;
  args: string[];
  /** the LSP `languageId` to tag opened documents with. */
  languageId: string;
}

/** First-match-wins; ordering is priority. Extend by adding a row. */
export const LSP_SERVERS: readonly LspServer[] = [
  { languages: ["rust"], command: "rust-analyzer", args: [], languageId: "rust" },
  { languages: ["cpp", "c"], command: "clangd", args: ["--background-index"], languageId: "cpp" },
  { languages: ["go"], command: "gopls", args: [], languageId: "go" },
  { languages: ["python"], command: "pyright-langserver", args: ["--stdio"], languageId: "python" },
  { languages: ["typescript", "javascript", "tsx"], command: "typescript-language-server", args: ["--stdio"], languageId: "typescript" },
];

const resolved = new Map<string, string | null>();
/** Resolve a command to its ABSOLUTE path via the login shell's PATH. `spawn`
 * resolves against `process.env.PATH`, which often omits `~/.cargo/bin`,
 * `~/go/bin`, etc. where these servers live — so `command -v` can find a server
 * that `spawn(cmd)` then can't. Spawning the absolute path avoids that mismatch. */
function resolveCommand(cmd: string): string | null {
  if (resolved.has(cmd)) return resolved.get(cmd)!;
  let abs: string | null = null;
  try { abs = execSync(`command -v ${cmd}`, { encoding: "utf8" }).trim() || null; } catch { abs = null; }
  resolved.set(cmd, abs);
  return abs;
}

/** Pick the highest-priority installed server that covers at least one of the
 * languages present in the repo, with `command` resolved to an absolute path.
 * Returns null if none is installed. */
export function pickServer(languagesPresent: Set<string>): LspServer | null {
  return pickServers(languagesPresent)[0] ?? null;
}

/** EVERY installed server covering a language in the repo, in registry order,
 * with each `command` resolved to an absolute path.
 *
 * A polyglot repo has more than one, and picking only the first leaves the rest
 * of its languages unenriched for no reason: the rows are disjoint in the
 * languages they claim, so running all of them is strictly more coverage, not a
 * conflict. It also stops an unrelated language from deciding the outcome — a
 * Dart repo carrying a handful of `.c` files got clangd, because clangd sorts
 * first, and Dart went unenriched. */
export function pickServers(languagesPresent: Set<string>): LspServer[] {
  const out: LspServer[] = [];
  for (const s of LSP_SERVERS) {
    if (!s.languages.some((l) => languagesPresent.has(l))) continue;
    const abs = resolveCommand(s.command);
    if (abs) out.push({ ...s, command: abs });
  }
  return out;
}
