/**
 * wos-soul-sandbox.ts — STEP 3: rewrite bash tool calls into the Soul sandbox.
 *
 * Round 3 (DIR-wos structural decision): there is NO ALLOWANCE anymore. The
 * agent-side applier is deleted; Soul application runs only inside the Control
 * Tower server process. The sandbox therefore has NO exception to wrap, hijack,
 * or shadow: when the arm is ON, EVERY bash call runs inside soul_sandbox.sh
 * (01_Soul read-only, trust anchors read-only, key masked, IPC cut), or the
 * call is BLOCKED fail-closed. Old allowance shapes
 * (`... soul_apply_step.py ...`, plain or `timeout`-wrapped) are routed into
 * the sandbox like any other command.
 *
 * The rewrite runs the ORIGINAL command inside soul_sandbox.sh. Base64 carries the
 * original command exactly (no quoting, no shell parsing of it, ever). The sandbox
 * script path and the soul root are SINGLE-QUOTED (C5: the real soulRoot contains
 * spaces — unquoted, bash split it and every call failed 97). The base64 payload
 * needs no quoting (alphabet `[A-Za-z0-9+/=]` carries no shell metacharacter).
 *
 * @pi-child-safe: tool-call rewrite only (bash → sandbox wrapper); no I/O except switch-file and local staging-dir existence checks; never remaps the child's model.
 * (request 2026-09-27: this line used to read ` * // @pi-child-safe: …`, which
 * child-extensions.ts MARKER_RE never matched — so this extension had never loaded in any Pi child.)
 *
 * TWO INDEPENDENT SWITCHES (a present file = ON; both absent at install):
 *   ~/.wos-runtime/state/soul_guard/ENABLE_step3_children     — pi-spawned children
 *     (child = PI_SUBAGENT_AGENT is set; the top-level Director never carries it).
 *     Butler's authority: Butler additionally owns whether this file's @pi-child-safe
 *     marker line stays (marker removal = the extension never loads in children).
 *   ~/.wos-runtime/state/soul_guard/ENABLE_step3_interactive  — interactive sessions.
 *     the owner's decision, because with the bash tool sandboxed the agent cannot sudo
 *     through bash; privileged steps move to the owner (or a parent outside the guard).
 *
 * VERIFIER ARM (request 2026-09-27) — ON by default, no ENABLE file:
 *   a Pi child whose harness-set PI_SUBAGENT_AGENT is `verifier` gets EVERY bash call routed into
 *   soul_sandbox.sh `verifier` mode (01_Soul, control_tower, trust anchors, pi_extensions read-only; IPC
 *   left open so `crontab -l` / `systemctl --user status` still work). Off switch (DIR-wos only; the
 *   dir is read-only inside the sandbox): ~/.wos-runtime/state/soul_guard/verifier_boundary.off
 *   Threat model: accidental writes by a checker, not a malicious same-uid process. When a step-3 arm
 *   is also ON, the stricter soul mode wins. Fail closed: sandbox missing → the call is blocked (not
 *   terminated, so the verifier can still report UNRESOLVED).
 * VERIFIER ARM r2 (request 2026-09-23 r2): soul_sandbox.sh verifier mode also binds
 *   fleet/loops/harness/butler/pi_packages/doctor.d, Pi's settings/models/trust/APPEND_SYSTEM/bin, ~/.local/bin,
 *   the subagents package and 02_Cases/_ledgers read-only; this file adds (a) the staging package(s) the task
 *   names as extra read-only roots (4th sandbox arg) and (b) a refusal of a live `--apply` (VERIFIER_NO_APPLY).
 *   The verifier keeps write access to /tmp, $TMPDIR and the rest of staging (its report folder).
 *   INERT until ~/.wos-runtime/state/soul_guard/ENABLE_verifier_boundary_r2 exists (sandbox mode `verifier2`);
 *   without it the arm routes byte-identically to the 09-27 bytes. verifier_boundary.off still turns the whole arm off.
 * VERIFIER JAIL (request 2026-10-03, P0 2026-10-03 12:13Z) — ON by default for verifier children:
 *   the r2 arm is a DENYLIST of read-only binds on named paths; /srv/users/<u>/sync-home IS $HOME (same dev:ino)
 *   and sync-home/wisdom-os is a second wisdom-os mount, so a verifier wrote live 01_Soul through the alias and then ran
 *   `rm -rf "/srv/users"`. The jail is an ALLOWLIST: every bash call runs in ~/.wos-runtime/butler/verifier_jail.sh,
 *   which makes the WHOLE mount tree read-only (mount_setattr AT_RECURSIVE) and re-opens only (a) a per-child
 *   owner-only temp root /tmp/wos-vjail-<uid>-XXXXXX (TMPDIR inside) and (b) the child's report dir(s) under
 *   ~/.wos-runtime/staging that the task names (report-word suffix, see REPORT FOLDERS; never a review root). The
 *   write/edit tools are refused outside the same roots (realpath of the target or its nearest existing ancestor).
 *   A live `--apply` is still refused up front (VERIFIER_NO_APPLY). Off switch (DIR-wos only; reverts to r2/verifier
 *   routing): ~/.wos-runtime/state/soul_guard/verifier_jail.off. verifier_boundary.off still turns the whole arm off.
 *   Fail closed: jail script missing → the call is blocked. Env WOS_VERIFIER_JAIL=1/0 overrides (hermetic tests),
 *   WOS_VERIFIER_JAIL_SH=<path> points at a test copy.
 * Hermetic-test overrides: WOS_SOUL_GUARD_STATE=<dir>, WOS_SOUL_SANDBOX_CHILDREN=1/0,
 *   WOS_SOUL_SANDBOX_INTERACTIVE=1/0, WOS_SOUL_ROOT=<ro-dir>, WOS_SOUL_SANDBOX_SH=<path>.
 *
 * FAIL CLOSED: when sandboxing is ON for the session but the sandbox script is
 * missing or not executable, the call is BLOCKED with a clear message — never
 * silently run unsandboxed.
 *
 * request 2026-09-23 steps 2+3, round 3.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STEP = "step3-soul-sandbox";
export const SETUP_FAILED_CODE = "SOUL_SANDBOX_SETUP_FAILED";

export function stateDir(): string {
  return process.env.WOS_SOUL_GUARD_STATE ||
    path.join(os.homedir(), ".wos-runtime", "state", "soul_guard");
}

function flagFile(name: string): boolean {
  try {
    return fs.existsSync(path.join(stateDir(), name));
  } catch {
    return false;
  }
}

/** Exported for tests. */
export function isChildSession(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.PI_SUBAGENT_AGENT);
}

/** Exported for tests. True when THIS session's arm of the switch is ON. */
export function step3EnabledFor(
  child: boolean,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (child) {
    if (env.WOS_SOUL_SANDBOX_CHILDREN === "1") return true;
    if (env.WOS_SOUL_SANDBOX_CHILDREN === "0") return false;
    return flagFile("ENABLE_step3_children");
  }
  if (env.WOS_SOUL_SANDBOX_INTERACTIVE === "1") return true;
  if (env.WOS_SOUL_SANDBOX_INTERACTIVE === "0") return false;
  return flagFile("ENABLE_step3_interactive");
}

export const VERIFIER_OFF_FILE = "verifier_boundary.off";

/** Exported for tests. The declared role comes from the harness env, never from prompt text. */
export function isVerifierSession(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.PI_SUBAGENT_AGENT ?? "").trim().toLowerCase() === "verifier";
}

/** Exported for tests. Verifier arm: ON for verifier children unless the off file exists. */
export function verifierBoundaryOn(env: Record<string, string | undefined> = process.env): boolean {
  return isVerifierSession(env) && !flagFile(VERIFIER_OFF_FILE);
}

/** r2 switch (inert install): a present file = r2 ON. Env WOS_VERIFIER_BOUNDARY_R2=1/0 overrides (hermetic tests).
 *  Absent → the verifier arm routes exactly as before r2 (`… verifier`, no review roots, no --apply refusal). */
export const R2_ENABLE_FILE = "ENABLE_verifier_boundary_r2";

/** Exported for tests. */
export function verifierR2On(env: Record<string, string | undefined> = process.env): boolean {
  if (env.WOS_VERIFIER_BOUNDARY_R2 === "1") return true;
  if (env.WOS_VERIFIER_BOUNDARY_R2 === "0") return false;
  return flagFile(R2_ENABLE_FILE);
}

/* ── r2 (request 2026-09-23 r2) ────────────────────────────────────────────────
 * REVIEW ROOTS. The package a verifier checks must not be rewritable by the verifier (2026-09-30: a verifier
 * re-running a package's tests rewrote its sealed evidence/compare_e2e.txt). The task text (the parent's prompt,
 * captured from before_agent_start and from the session branch's user messages, so resume/fork keeps it) names the
 * package by req id or by path; every EXISTING ~/.wos-runtime/staging package dir it names becomes read-only inside
 * the verifier sandbox. Prompt text may only ADD read-only roots — it can never relax the boundary.
 * REPORT FOLDERS stay writable (r2.1): a dir named `<req id>-<suffix>` whose SUFFIX (the part after the dated
 * `-YYYYMMDD-NN` core) carries a report word — verify/verifier/verification/canary/review/audit/report/check —
 * e.g. `request 2026-09-23-verify-r2`, `request 2026-09-23-canary`. The word is matched ONLY in the suffix: r2 matched
 * it anywhere in the name, so a package whose req id itself contains "verifier" (this one) was never protected
 * (live canary 2026-10-01, request 2026-10-01: review roots empty). A non-req dir name is a report
 * folder only if the whole name carries the word.
 * Staging lives on local disk (~/.wos-runtime), so these existence checks never touch the wisdom-os FUSE mount. */
const REPORT_WORD_RE = /(?:^|[-_.])(?:verif(?:y|ier|ication)|canary|review|audit|report|check)(?:$|[-_.\d])/i;
const REQ_TOKEN_RE = /\breq-[A-Za-z0-9][A-Za-z0-9._-]*/g;
const REQ_CORE_RE = /^(req-[A-Za-z0-9._-]*?-\d{8}-\d{2})(?![0-9])/;

/** Exported for tests. True for a verifier's report folder name (see REPORT FOLDERS above). */
export function isReportDirName(name: string): boolean {
  const core = REQ_CORE_RE.exec(name);
  return REPORT_WORD_RE.test(core ? name.slice(core[1].length) : name);
}

function stagingDir(home: string): string {
  return path.join(home, ".wos-runtime", "staging");
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Exported for tests. Staging package dirs named in `text` (req ids and staging paths), existing only. */
export function reviewRootsFromText(text: string, home: string = os.homedir()): string[] {
  const st = stagingDir(home);
  const out = new Set<string>();
  const add = (p: string) => {
    const rel = path.relative(st, p);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
    if (isReportDirName(path.basename(p))) return;
    if (isDir(p)) out.add(p);
  };
  const s = String(text ?? "");
  // 1. explicit staging paths: ~/…, $HOME/…, ${HOME}/…, /home/<u>/…  → staging/<a>[/<b>]
  const pathRe = /(?:~|\$\{?HOME\}?|\/home\/[A-Za-z0-9._-]+)\/\.wos-runtime\/staging\/([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._-]+))?/g;
  for (const m of s.matchAll(pathRe)) {
    const a = m[1], b = m[2];
    if (/^req-/.test(a) || !b) add(path.join(st, a));
    else add(path.join(st, a, b));
  }
  // 2. bare req ids: staging/<id> or staging/<project>/<id> (full token and its dated core)
  const names = new Set<string>();
  for (const m of s.matchAll(REQ_TOKEN_RE)) {
    const tok = m[0].replace(/[._-]+$/, "");
    names.add(tok);
    const core = REQ_CORE_RE.exec(tok);
    if (core) names.add(core[1]);
  }
  if (names.size) {
    let projects: string[] = [];
    try { projects = fs.readdirSync(st).filter((d) => !/^req-/.test(d) && isDir(path.join(st, d))); } catch { /* no staging */ }
    for (const n of names) {
      add(path.join(st, n));
      for (const pr of projects) add(path.join(st, pr, n));
    }
  }
  return [...out].sort();
}

const reviewText: string[] = [];
let reviewCache: { key: string; roots: string[] } = { key: "", roots: [] };

function userTextsFromBranch(ctx: any): string[] {
  const out: string[] = [];
  let branch: any[] = [];
  try { branch = ctx?.sessionManager?.getBranch?.() ?? []; } catch { branch = []; }
  for (const e of Array.isArray(branch) ? branch : []) {
    const msg = e?.message ?? e;
    if (msg?.role !== "user") continue;
    const c = msg.content;
    if (typeof c === "string") out.push(c);
    else if (Array.isArray(c)) for (const part of c) if (typeof part?.text === "string") out.push(part.text);
  }
  return out;
}

/** r2.1: the AUTHORITATIVE harness source. The subagents package writes the full task to
 *  <artifactDir>/context/<name>-<ts>.md and launches the child with the positional argv `@<that file>`
 *  (index.ts spawn: `taskArg = \`@${artifactPath}\``; resume: `@${resumeMsgFile}`). Read those files once (local
 *  disk under ~/.pi/agent/sessions, never the FUSE mount), independent of how Pi turns them into messages. */
let harnessTextCache: string[] | null = null;
export function harnessTaskTexts(argv: string[] = process.argv, home: string = os.homedir()): string[] {
  if (argv === process.argv && harnessTextCache) return harnessTextCache;
  const root = path.join(home, ".pi", "agent", "sessions") + path.sep;
  const out: string[] = [];
  for (const a of argv) {
    if (typeof a !== "string" || !a.startsWith("@")) continue;
    const f = path.resolve(a.slice(1));
    if (!f.startsWith(root) || !f.endsWith(".md")) continue;
    try { const st = fs.statSync(f); if (st.isFile() && st.size <= 4 << 20) out.push(fs.readFileSync(f, "utf8")); } catch { /* gone */ }
  }
  if (argv === process.argv) harnessTextCache = out;
  return out;
}

/** Exported for tests. Review roots for THIS session (harness task files ∪ captured prompts ∪ branch user messages). */
export function sessionReviewRoots(ctx?: any, home: string = os.homedir()): string[] {
  const texts = [...harnessTaskTexts(process.argv, home), ...reviewText, ...userTextsFromBranch(ctx)];
  const key = home + "\0" + texts.length + "\0" + texts.reduce((n, t) => n + t.length, 0);
  if (reviewCache.key === key) return reviewCache.roots;
  const roots = reviewRootsFromText(texts.join("\n"), home);
  reviewCache = { key, roots };
  return roots;
}

/** Exported for tests. */
export function rememberPrompt(text: unknown): void {
  if (typeof text === "string" && text) reviewText.push(text);
}

/* NO --apply FROM A VERIFIER. The install gate (fleet/install_gate.py, hooked in wos-guards.ts) refuses a child's
 * live --apply — but wos-guards.ts is not child-safe, so it never loads in a Pi child. This is the verifier-side
 * twin, deliberately small: refuse a simple command that RUNS a script/interpreter with an argv word `--apply`
 * (or `--apply=…`) unless that command (or an earlier `export HOME=` / `HOME=` in the same call) points HOME at
 * something other than the real home (a rehearsal on a sandbox home). Text programs (grep/sed/echo/cat…) carrying
 * `--apply` are data; `bash -c '<string>'` / `sh -c` strings are analysed recursively; heredoc bodies are data.
 * The read-only mounts are the enforcement; this only turns an accidental live install into a clear refusal. */
const EXEC_PROGS = /^(?:python(?:\d+(?:\.\d+)?)?|bash|sh|zsh|dash|node|bun|deno|perl|ruby|tsx|ts-node)$/;
const WRAPPERS = new Set(["env", "sudo", "nice", "nohup", "exec", "command", "time", "stdbuf", "setsid", "ionice", "chrt", "timeout"]);

type Word = { w: string; q: boolean };

function stripHeredocs(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let pending: string[] = [];
  for (const line of lines) {
    if (pending.length) {
      const t = line.replace(/^\t+/, "");
      if (t === pending[0]) pending.shift();
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) pending.push(m[2]);
  }
  return out.join("\n");
}

/** Split into simple commands of words (quotes honoured; `$(…)`/backticks kept inside the word). */
function simpleCommands(src: string): Word[][] {
  const cmds: Word[][] = [];
  let cur: Word[] = [];
  let w = "", q = false, inWord = false;
  const endWord = () => { if (inWord) cur.push({ w, q }); w = ""; q = false; inWord = false; };
  const endCmd = () => { endWord(); if (cur.length) cmds.push(cur); cur = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") { const j = src.indexOf("'", i + 1); const e = j < 0 ? src.length : j; w += src.slice(i + 1, e); q = true; inWord = true; i = e; continue; }
    if (c === '"') {
      let j = i + 1; let buf = "";
      while (j < src.length && src[j] !== '"') { if (src[j] === "\\" && j + 1 < src.length) { buf += src[j + 1]; j += 2; continue; } buf += src[j]; j++; }
      w += buf; q = true; inWord = true; i = j; continue;
    }
    if (c === "\\" && i + 1 < src.length) { if (src[i + 1] !== "\n") { w += src[i + 1]; inWord = true; } i++; continue; }
    if (c === "#" && !inWord) { const j = src.indexOf("\n", i); i = (j < 0 ? src.length : j) - 1; continue; }
    if (c === " " || c === "\t") { endWord(); continue; }
    if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "{" || c === "}") {
      if ((c === "{" || c === "}") && inWord) { w += c; continue; }
      endCmd(); continue;
    }
    if ((c === "<" || c === ">") && !inWord) {          // redirection: drop the operator and its target word
      let j = i + 1; while (j < src.length && /[<>&|0-9-]/.test(src[j])) j++;
      while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
      let k = j; while (k < src.length && !/[\s;&|()]/.test(src[k])) k++;
      i = k - 1; continue;
    }
    w += c; inWord = true;
  }
  endCmd();
  return cmds;
}

function isRealHome(v: string, home: string): boolean {
  const t = v.trim();
  if (!t || t === "~" || t === "$HOME" || t === "${HOME}") return true;
  return path.resolve(t.replace(/\/+$/, "") || "/") === path.resolve(home);
}

/** Exported for tests. → the offending simple command, or null. */
export function liveApplyOf(command: string, home: string = os.homedir(), depth = 0): string | null {
  if (depth > 3) return null;
  let sessionHomeSandbox = false;
  for (const words of simpleCommands(stripHeredocs(String(command ?? "")))) {
    let i = 0;
    let cmdHomeSandbox: boolean | null = null;
    const assign = (wd: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(wd);
    while (i < words.length && assign(words[i].w)) {
      const [k, ...v] = words[i].w.split("=");
      if (k === "HOME") cmdHomeSandbox = !isRealHome(v.join("="), home);
      i++;
    }
    if (i >= words.length) { if (cmdHomeSandbox !== null) sessionHomeSandbox = cmdHomeSandbox; continue; }
    if (words[i].w === "export") {
      for (const x of words.slice(i + 1)) if (x.w.startsWith("HOME=")) sessionHomeSandbox = !isRealHome(x.w.slice(5), home);
      continue;
    }
    // skip wrappers (env FOO=1 …, sudo -u x …, timeout 30 …)
    while (i < words.length) {
      const b = path.basename(words[i].w);
      if (!WRAPPERS.has(b)) break;
      i++;
      while (i < words.length && (words[i].w.startsWith("-") || assign(words[i].w) || /^\d+[smhd]?$/.test(words[i].w))) {
        if (words[i].w.startsWith("HOME=")) cmdHomeSandbox = !isRealHome(words[i].w.slice(5), home);
        i++;
      }
    }
    if (i >= words.length) continue;
    const prog = words[i].w;
    const base = path.basename(prog);
    const args = words.slice(i + 1);
    const runsCode = EXEC_PROGS.test(base) || /\.(?:py|sh|mjs|js|ts)$/.test(base) || (prog.includes("/") && !/^(?:grep|egrep|fgrep|rg|sed|awk|cat|echo|printf|less|head|tail|diff|wc|sha256sum|ls|stat|file|strings|jq)$/.test(base));
    if (!runsCode) continue;
    if (/^(?:bash|sh|zsh|dash)$/.test(base)) {
      const ci = args.findIndex((a) => a.w === "-c" || /^-[a-z]*c$/.test(a.w));
      if (ci >= 0 && args[ci + 1]) { const inner = liveApplyOf(args[ci + 1].w, home, depth + 1); if (inner) return inner; continue; }
    }
    const applies = args.some((a) => a.w === "--apply" || a.w.startsWith("--apply="));
    if (!applies) continue;
    const sandboxHome = cmdHomeSandbox !== null ? cmdHomeSandbox : sessionHomeSandbox;
    if (!sandboxHome) return words.map((x) => x.w).join(" ").slice(0, 300);
  }
  return null;
}

export const NO_APPLY_CODE = "VERIFIER_NO_APPLY";

/* ── VERIFIER JAIL (request 2026-10-03) ─────────────────────────────────────────────────── */
export const JAIL_OFF_FILE = "verifier_jail.off";
export const JAIL_WRITE_CODE = "VERIFIER_JAIL_WRITE_REFUSED";

/** Exported for tests. Jail: ON for verifier children unless verifier_jail.off (or verifier_boundary.off) exists. */
export function verifierJailOn(env: Record<string, string | undefined> = process.env): boolean {
  if (!isVerifierSession(env) || flagFile(VERIFIER_OFF_FILE)) return false;
  if (env.WOS_VERIFIER_JAIL === "1") return true;
  if (env.WOS_VERIFIER_JAIL === "0") return false;
  return !flagFile(JAIL_OFF_FILE);
}

/** Exported for tests. */
export function jailScript(): string {
  return process.env.WOS_VERIFIER_JAIL_SH || path.join(os.homedir(), ".wos-runtime", "butler", "verifier_jail.sh");
}

function jailUsable(): boolean {
  try { fs.accessSync(jailScript(), fs.constants.X_OK); return true; } catch { return false; }
}

let jailRoot = "";
/** Exported for tests. The per-child temp root: one owner-only mkdtemp dir under /tmp per Pi process, re-made if gone. */
export function jailTempRoot(): string {
  try {
    if (jailRoot) {
      const st = fs.lstatSync(jailRoot);
      if (st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o777) === 0o700) return jailRoot;
    }
  } catch { /* gone: make a new one */ }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  jailRoot = fs.mkdtempSync(`/tmp/wos-vjail-${uid}-`);
  fs.chmodSync(jailRoot, 0o700);
  return jailRoot;
}

function realStaging(home: string): string {
  try { return fs.realpathSync(stagingDir(home)); } catch { return ""; }
}

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
}

/** Exported for tests. Report dirs the task names (a report-word name, see isReportDirName), never a review root or
 *  inside one, always strictly inside ~/.wos-runtime/staging. A named report dir that does not exist yet is created
 *  (mode 700) when its parent is staging/ or staging/<project>/ and exists: the verifier cannot mkdir it from inside. */
export function reportRootsFromText(text: string, home: string = os.homedir(), review: string[] = []): string[] {
  const st = stagingDir(home);
  const stReal = realStaging(home);
  if (!stReal) return [];
  const reviewReal = review.map((r) => { try { return fs.realpathSync(r); } catch { return r; } });
  const cands = new Set<string>();
  const explicitReports = new Set<string>();
  const s = String(text ?? "");
  // Normalize explicit paths first, including `fix/../verify-…/REPORT.md`; the verifier's report sibling may not exist yet.
  const fullPathRe = /(?:~|\$\{?HOME\}?|\/home\/[A-Za-z0-9._-]+)\/\.wos-runtime\/staging\/[A-Za-z0-9._\/-]+/g;
  for (const m of s.matchAll(fullPathRe)) {
    let raw = m[0].replace(/^~|^\$\{?HOME\}?/, home).replace(/[.,;:)]+$/, "");
    let p = path.resolve(raw);
    if (/\.[A-Za-z0-9]{1,8}$/.test(path.basename(p))) p = path.dirname(p);
    if (isReportDirName(path.basename(p))) { cands.add(p); explicitReports.add(p); }
  }
  const pathRe = /(?:~|\$\{?HOME\}?|\/home\/[A-Za-z0-9._-]+)\/\.wos-runtime\/staging\/([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._-]+))?(?:\/([A-Za-z0-9._-]+))?/g;
  for (const m of s.matchAll(pathRe)) {
    const segs = [m[1], m[2], m[3]].filter(Boolean) as string[];
    for (let i = 1; i <= segs.length; i++) if (isReportDirName(segs[i - 1])) { cands.add(path.join(st, ...segs.slice(0, i))); break; }
  }
  let projects: string[] = [];
  try { projects = fs.readdirSync(st).filter((d) => !/^req-/.test(d) && isDir(path.join(st, d))); } catch { /* none */ }
  for (const m of s.matchAll(REQ_TOKEN_RE)) {
    const tok = m[0].replace(/[._-]+$/, "");
    if (!REQ_CORE_RE.test(tok) || !isReportDirName(tok)) continue;
    const hits = [path.join(st, tok), ...projects.map((p) => path.join(st, p, tok))].filter(isDir);
    if (hits.length) { hits.forEach((h) => cands.add(h)); continue; }
    // not there yet: create it beside the package under review (same project), if exactly one project holds one
    const core = REQ_CORE_RE.exec(tok)![1];
    const homes = [st, ...projects.map((p) => path.join(st, p))].filter((d) => isDir(path.join(d, core)));
    if (homes.length === 1) cands.add(path.join(homes[0], tok));
  }
  const out = new Set<string>();
  for (const c of cands) {
    const rel = path.relative(st, c);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split("/").length > 3) continue;
    if (!fs.existsSync(c)) {
      const parent = path.dirname(c);
      if (path.relative(st, parent).split("/").filter(Boolean).length > 1) continue;
      try { const ps = fs.lstatSync(parent); if (!ps.isDirectory()) continue; fs.mkdirSync(c, { mode: 0o700 }); } catch { continue; }
    }
    let r = "";
    try { const ls = fs.lstatSync(c); if (!ls.isDirectory() || ls.isSymbolicLink()) continue; r = fs.realpathSync(c); } catch { continue; }
    if (!under(r, stReal) || r === stReal) continue;
    if (!explicitReports.has(c) && reviewReal.some((v) => under(r, v) || under(v, r))) continue;  // explicit named report dirs win; inferred review roots stay read-only
    out.add(r);
    if (out.size >= 16) break;
  }
  return [...out].sort();
}

let reportCache: { key: string; roots: string[] } = { key: "", roots: [] };
/** Exported for tests. Report roots for THIS session (same text sources as sessionReviewRoots). */
export function sessionReportRoots(ctx?: any, home: string = os.homedir()): string[] {
  const texts = [...harnessTaskTexts(process.argv, home), ...reviewText, ...userTextsFromBranch(ctx)];
  const key = home + "\0" + texts.length + "\0" + texts.reduce((n, t) => n + t.length, 0);
  if (reportCache.key === key && reportCache.roots.every(isDir)) return reportCache.roots;
  const roots = reportRootsFromText(texts.join("\n"), home, reviewRootsFromText(texts.join("\n"), home));
  reportCache = { key, roots };
  return roots;
}

/** Exported for tests. Real path of `p` (or of its nearest existing ancestor + the rest), symlinks resolved. */
export function resolveForWrite(p: string, cwd: string): string {
  let abs = path.resolve(cwd, p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
  const rest: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(abs), ...rest.reverse()); } catch { /* not there yet */ }
    const parent = path.dirname(abs);
    if (parent === abs) return path.join(abs, ...rest.reverse());
    rest.push(path.basename(abs));
    abs = parent;
  }
}

/** Exported for tests. "" = allowed; else the refusal reason. */
export function jailWriteVerdict(p: string, cwd: string, roots: string[]): string {
  if (!p) return `${JAIL_WRITE_CODE}: no target path`;
  const r = resolveForWrite(p, cwd);
  const realRoots = roots.map((x) => { try { return fs.realpathSync(x); } catch { return ""; } }).filter(Boolean);
  if (realRoots.some((x) => under(r, x) && r !== x)) return "";
  return `${JAIL_WRITE_CODE}: a verifier writes only inside its own temp root or its report dir. Refused: ${p} ` +
    `(resolves to ${r}). Writable: ${realRoots.join(", ")}. Copy what you need there (cp, never ln -s) and work on ` +
    `the copy; name any live change as a step for DIR-wos in your report. ` +
    `🔴 2026-10-03 a verifier wrote live 01_Soul through /srv/users/<u>/sync-home (an alias of $HOME), then ran rm -rf on it.`;
}

/** Exported for tests. The jail rewrite of one bash command. */
export function routeJail(command: string, opts: { jail: string; troot: string; roots: string[]; usable: boolean; notify?: string }): string {
  if (!opts.usable) {
    const err: any = new Error(`${SETUP_FAILED_CODE}: verifier jail is ON but ${opts.jail} is missing or not executable — ` +
      `refusing to run unjailed. Have DIR-wos restore it or create ~/.wos-runtime/state/soul_guard/${JAIL_OFF_FILE}.`);
    err.block = true;
    throw err;
  }
  const payload = opts.notify ? `printf '%s\\n' ${shQuote(opts.notify)} >&2\n${String(command ?? "")}` : String(command ?? "");
  const b64 = Buffer.from(payload, "utf8").toString("base64");
  const roots = opts.roots.length ? " " + Buffer.from(opts.roots.join("\n"), "utf8").toString("base64") : "";
  return `${shQuote(opts.jail)} ${shQuote(opts.troot)} ${b64}${roots}`;
}

/** Exported for tests. */
export function sandboxScript(): string {
  return process.env.WOS_SOUL_SANDBOX_SH ||
    path.join(os.homedir(), ".wos-runtime", "butler", "soul_sandbox.sh");
}

/** Exported for tests. */
export function soulRoot(): string {
  if (process.env.WOS_SOUL_ROOT) return path.resolve(process.env.WOS_SOUL_ROOT);
  const wosRoot =
    process.env.WISDOM_OS_ROOT || path.join(os.homedir(), "wisdom-os");
  return path.resolve(wosRoot, "Obsidian Vault", "Context", "01_Soul");
}

/** Shell single-quote (C5). Exported for tests. */
export function shQuote(s: string): string {
  return "'" + String(s ?? "").replace(/'/g, "'\\''") + "'";
}

/** Exported for tests. */
export function sandboxUsable(): boolean {
  try {
    fs.accessSync(sandboxScript(), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exported for tests. Returns the rewritten command, or null when sandboxing does
 * not apply to this call. Throws { block, reason } when fail-closed triggers.
 * There is deliberately NO applier pass-through: every command is sandboxed.
 */
export function routeBash(
  command: string,
  opts: { enabled: boolean; soul: string; sandbox: string; usable: boolean; mode?: "soul" | "verifier" | "verifier2"; review?: string[] },
): string | null {
  if (!opts.enabled) return null;
  const verifier = opts.mode === "verifier" || opts.mode === "verifier2";
  const v2 = opts.mode === "verifier2";
  if (!opts.usable) {
    const err: any = new Error(
      `${SETUP_FAILED_CODE}: Soul bash sandbox is ON but ${opts.sandbox} is missing or ` +
      `not executable — refusing to run unsandboxed. Restore the script or ` +
      (verifier
        ? `have DIR-wos create ~/.wos-runtime/state/soul_guard/${VERIFIER_OFF_FILE} to revert.`
        : `remove the ENABLE_step3_* switch to revert.`),
    );
    err.block = true;
    throw err;
  }
  const b64 = Buffer.from(String(command ?? ""), "utf8").toString("base64");
  const review = v2 && opts.review && opts.review.length
    ? " " + Buffer.from(opts.review.join("\n"), "utf8").toString("base64")
    : "";
  return `${shQuote(opts.sandbox)} ${shQuote(opts.soul)} ${b64}` + (v2 ? " verifier2" + review : verifier ? " verifier" : "");
}

export default function (pi: ExtensionAPI) {
  let jailHintSent = false;
  // r2: remember the parent's task text (verifier children only; pure in-memory capture, returns nothing).
  pi.on("before_agent_start" as any, async (event: any) => {
    if (isChildSession() && isVerifierSession() && (verifierR2On() || verifierJailOn())) rememberPrompt(event?.prompt);
  });
  pi.on("tool_call", async (event: any, ctx?: any) => {
    const tool = event?.toolName;
    if (tool !== "bash" && tool !== "write" && tool !== "edit") return;
    const child = isChildSession();
    // VERIFIER JAIL: takes precedence over every other arm for a verifier child.
    if (child && verifierJailOn()) {
      let troot = "";
      try { troot = jailTempRoot(); } catch (e: any) {
        return { block: true, reason: `${SETUP_FAILED_CODE}: verifier jail could not create its temp root: ${e?.message ?? e}` };
      }
      const roots = sessionReportRoots(ctx);
      if (tool !== "bash") {
        const p = String(event?.input?.path ?? event?.input?.file_path ?? "");
        const why = jailWriteVerdict(p, String(ctx?.cwd || process.cwd()), [troot, ...roots]);
        return why ? { block: true, reason: why } : undefined;
      }
      const command = String(event?.input?.command ?? "");
      const hit = liveApplyOf(command);
      if (hit) {
        return {
          block: true,
          reason: `${NO_APPLY_CODE}: a verifier never runs an installer with --apply against the live home ` +
            `(install gate: children never --apply live). Refused: \`${hit}\`. Rehearse it on a copy with ` +
            `HOME=<a dir under $TMPDIR (${troot})>, or name the install step for DIR-wos in your report.`,
        };
      }
      try {
        const notify = !roots.length && !jailHintSent ? `VERIFIER_JAIL_REPORT_ROOT: no named report dir was found; write the report under ${troot}` : undefined;
        event.input.command = routeJail(command, { jail: jailScript(), troot, roots, usable: jailUsable(), notify });
        if (notify) jailHintSent = true;
      } catch (err: any) {
        return { block: true, reason: String(err?.message ?? err) };
      }
      return;
    }
    if (tool !== "bash") return;
    const enabled = step3EnabledFor(child);
    const verifier = !enabled && child && verifierBoundaryOn();
    if (!enabled && !verifier) return; // no arm ON for this session: pass-through
    const v2 = verifier && verifierR2On();
    const command = String(event?.input?.command ?? "");
    if (v2) {
      const hit = liveApplyOf(command);
      if (hit) {
        return {
          block: true,
          reason: `${NO_APPLY_CODE}: a verifier never runs an installer with --apply against the live home ` +
            `(install gate: children never --apply live). Refused: \`${hit}\`. Rehearse it on a copy with ` +
            `HOME=<owner-only temp sandbox>, or name the install step for DIR-wos in your report.`,
        };
      }
    }
    try {
      const routed = routeBash(command, {
        enabled: true,
        soul: soulRoot(),
        sandbox: sandboxScript(),
        usable: sandboxUsable(),
        mode: v2 ? "verifier2" : verifier ? "verifier" : "soul",
        review: v2 ? sessionReviewRoots(ctx) : undefined,
      });
      if (routed === null) return;
      event.input.command = routed;
    } catch (err: any) {
      if (err?.block && verifier) return { block: true, reason: String(err.message) };
      if (err?.block) return { block: true, reason: String(err.message), terminate: true };
      throw err;
    }
  });
}
