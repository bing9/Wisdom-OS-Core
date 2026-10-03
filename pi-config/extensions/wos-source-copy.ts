/**
 * wos-source-copy — raw copies of narrower-audience sources never land in org-visible Projects/.
 * (request 2026-10-03)
 *
 * @pi-child-safe: privacy rail — children run the fetches and copies that wrote the 2026-10-03 incident files; the
 * guard must bind them too
 *
 * 🔴 INCIDENT 2026-10-03. `Obsidian Vault/Projects` grants COMMENTER to the domain "Monetization + Partners"; agents
 * wrote 224+ full copies of narrower sources (Doc exports, comment threads, GChat dumps, transcripts, task dumps,
 * session prompts, scrollbacks, Soul snapshots) into Projects/<p>/. Forensics: ad-hoc agent bash (`internal-cli … > Projects`,
 * fetch to /tmp then `cp`), python/write-tool copies of local trees. The judge is
 * ~/.wos-runtime/source_copy/source_copy_guard.py (name + content rules + a taint ledger of fetched bytes).
 *
 * Hook points (r4; mirror wos-cell-egress.ts, plus a pre-write and pre-bash block). Every judge call is ASYNC
 * (execFile), and the only fs calls are on paths lexically on the wisdom-os mount, each under a 1.5 s timeout (M2).
 *   1. tool_call write/edit:
 *      - a target under Projects/ → `pre-write` judges the bytes about to land (edit: the file with the edits
 *        applied). REFUSE → blocked, nothing written. A judge that cannot run → blocked (fail closed, Projects/ only).
 *   2. tool_call bash (a source-fetch token, a mention of source_copy, or a Projects/ path/cwd) → `pre-bash`:
 *      blocks a fetch whose redirect / tee / --output target resolves under Projects/ (unless every doc id is
 *      verified org-wide).
 *   3. tool_result bash → `post-bash`: taint for fetch outputs outside Projects/; then every Projects/ file under the
 *      named roots changed since the call started (mtime) is judged; only REFUSED/moved reaches the agent; never-overridable classes and narrower/unverifiable doc
 *      exports are MOVED to ~/.wos-runtime/data/<project>/sources/<same path> (journal, dest-sha check, a stub left in
 *      place, a once-per-file relay to the owner); an id-less doc export is a NOTICE + relay.
 * Residual (REPORT): scripts / symlinks / env-var paths the command does not name, crons and non-Pi writers. These
 * are closed by the 4-hourly `relay-sweep` cron (moves never-overridable copies, relays the rest), not per call.
 * Single-user simplify 2026-10-03 (request 2026-10-03): state self-protection, per-call snapshots and
 * INCONCLUSIVE/notice output were removed — accident model, not attacker model.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const TOOL = path.join(HOME, ".wos-runtime", "source_copy", "source_copy_guard.py");
const PROJECTS_HINT = /\/Obsidian Vault\/Projects\//;
const GDRIVE_PREFIX = path.join(HOME, "wisdom-os") + "/";
const FETCH_HINT = /\bmeta\s[^\n]*?(google\.(docs|drive|slides|chat)|gchat|search\.knowledge|knowledge|url\.load|tasks\.task|calendar)/;
const TIMEOUT_PRE_MS = 20000;
const TIMEOUT_POST_MS = 45000;
const FS_TIMEOUT_MS = 1500;           // r4 (M2): a stalled FUSE mount must never block the hook
const started = new Map<string, number>();

function sessionId(ctx: any): string {
  try { return String(ctx?.sessionManager?.getSessionId?.() ?? ""); } catch { return ""; }
}

function cwdOf(ctx: any): string {
  try { return String(ctx?.cwd || process.cwd()); } catch { return process.cwd(); }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

/** exported for tests: lexical absolute target (no fs call). */
export function lexicalTarget(raw: unknown, cwd: string): string {
  const v = String(raw ?? "").replace(/^~(?=\/)/, HOME);
  return path.resolve(cwd || process.cwd(), v);
}

/** exported for tests (r4 M2): only paths lexically on the wisdom-os mount or naming Projects/ ever touch the fs; there
 *  the parent is realpath'd asynchronously with a timeout (a stalled mount falls back to the lexical path). */
export async function targetOf(raw: unknown, cwd: string): Promise<string> {
  const abs = lexicalTarget(raw, cwd);
  if (!abs.startsWith(GDRIVE_PREFIX) && !PROJECTS_HINT.test(abs)) return abs;
  const rp = await withTimeout(fs.promises.realpath(path.dirname(abs)).then((d) => path.join(d, path.basename(abs))),
    FS_TIMEOUT_MS, abs);
  return rp;
}

/** exported for tests: does this path need the pre-write judge? (python decides definitively) */
export function inProjects(p: string): boolean {
  return PROJECTS_HINT.test(p);
}

/** exported for tests: the bytes an edit would leave on disk (best effort; unmatched edits are appended). */
export async function editedContent(target: string, input: any): Promise<string> {
  let cur = await withTimeout(fs.promises.readFile(target, "utf8"), FS_TIMEOUT_MS * 4, "");
  const edits: any[] = Array.isArray(input?.edits) ? input.edits
    : (input?.oldText !== undefined || input?.old_string !== undefined)
      ? [{ oldText: input.oldText ?? input.old_string, newText: input.newText ?? input.new_string }] : [];
  for (const e of edits) {
    const o = String(e?.oldText ?? e?.old_string ?? ""), n = String(e?.newText ?? e?.new_string ?? "");
    if (o && cur.includes(o)) cur = cur.replace(o, () => n); else cur += "\n" + n;
  }
  return cur;
}

/** async python call (never blocks the event loop). */
function judge(args: string[], input: string, timeoutMs: number): Promise<{ rc: number; text: string }> {
  return new Promise((resolve) => {
    const child = execFile("/usr/bin/python3", ["-I", TOOL, ...args], { timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err: any, stdout: string) => {
        const rc = err ? (typeof err.code === "number" ? err.code : 2) : 0;
        resolve({ rc, text: String(stdout || "").trim() });
      });
    try { child.stdin?.end(input.slice(0, 2_000_000)); } catch { /* the child reports */ }
  });
}

/** exported for tests: does this bash call need the post-check? */
export function needsPost(command: string, cwd: string): boolean {
  return PROJECTS_HINT.test(command) || PROJECTS_HINT.test(cwd + "/") || FETCH_HINT.test(command);
}

export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
      const name = event?.toolName;
      if (name === "bash") {
        const tid = String(event?.toolCallId ?? "");
        started.set(tid, Date.now());
        if (started.size > 500) started.clear();
        const command = String(event?.input?.command ?? "");
        const cwd = cwdOf(ctx);
        const post = needsPost(command, cwd);
        if (!FETCH_HINT.test(command)) return;        // pre-bash only refuses fetches into Projects/
        const r = await judge(["pre-bash", "--cwd", cwd], command, TIMEOUT_PRE_MS);
        if (r.rc === 1) return { block: true, reason: "🔴 SOURCE-COPY: " + r.text };
        return;
      }
      if (name !== "write" && name !== "edit") return;
      const raw = event?.input?.path ?? event?.input?.file_path;
      const target = await targetOf(raw, cwdOf(ctx));
      if (!inProjects(target)) return;
      const content = name === "write" ? String(event?.input?.content ?? "") : await editedContent(target, event?.input);
      const r = await judge(["pre-write", "--path", target, "--session", sessionId(ctx)], content, TIMEOUT_PRE_MS);
      if (r.rc === 0) return;
      if (r.rc === 1) return { block: true, reason: "🔴 SOURCE-COPY: " + r.text };
      return { block: true, reason: "🔴 SOURCE-COPY guard could not judge this write into org-visible Projects/ " +
        "(" + TOOL + " rc " + r.rc + "); nothing was written. Write it to the project's local home " +
        "(~/.wos-runtime/data/<project>/sources/) or report the guard failure to DIR-wos." };
    } catch {
      return;
    }
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    try {
      if (event?.toolName !== "bash") return;
      const tid = String(event?.toolCallId ?? "");
      const since = started.get(tid) ?? Date.now() - 600000;   // unknown start: look back 10 min (stricter)
      started.delete(tid);
      const command = String(event?.input?.command ?? "");
      const cwd = cwdOf(ctx);
      if (!needsPost(command, cwd)) return;
      const args = ["post-bash", "--cwd", cwd, "--session", sessionId(ctx), "--since", String(since / 1000)];
      const r = await judge(args, command, TIMEOUT_POST_MS);
      if (r.rc !== 1 || !r.text) return;               // only REFUSED/moved reaches the agent; notices live in events.jsonl
      const head = "\n🔴 SOURCE-COPY: raw source copies were written into org-visible Projects/:\n";
      const content = Array.isArray(event.content) ? [...event.content] : [];
      content.push({ type: "text", text: head + (r.text || "(no output)") });
      return { content };
    } catch {
      return;
    }
  });
}
