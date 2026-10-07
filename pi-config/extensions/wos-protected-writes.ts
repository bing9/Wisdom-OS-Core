/**
 * wos-protected-writes.ts — candidate first, promotion second.
 *
 * Background Pi agents cannot write canonical Soul. `wos_bg_sandbox` is the OS boundary; this
 * extension is the early, legible boundary: it blocks common tool calls before execution, writes
 * a durable event, and emits one exact-session BLOCKED producer report when a return envelope is
 * available. Since request 2026-10-03 foreground Pi no longer writes Soul either (see 01_Soul below).
 *
 * AGENTS.md (request 2026-09-26; the owner Q9 2026-09-26): the root constitution
 * `$WISDOM_OS_ROOT/AGENTS.md` is installer-only for EVERY Pi agent, foreground included. Agents draft
 * a candidate; DIR-wos verifies and installs with `~/.wos-runtime/harness/agents_md_install.py`, which
 * runs as its own process (seal + preimage + backup + ledger) and is therefore not a tool-level write.
 * Like the Soul gate this is early, legible refusal — not the security boundary; the installer's
 * ledger (`agents_md_install.py verify`, hourly cron with a Butler-inbox notice) detects any write that
 * slips past it. Cache-stable: nothing is injected into context, and the refusal text is constant.
 * Caught: write/edit (incl. a symlink named AGENTS.md); bash redirects (> >> >| &>), tee, sed/perl -i,
 * awk -i inplace, cp/install/rsync/ln/dd destination, mv, rm/truncate/touch/chmod, editors, git
 * checkout/restore/…, find -exec/-delete over the root, xargs mutators, bash/sh -c and eval (recursive),
 * interpreter writes (python/node/bun/deno/perl incl. 2-arg open(F,">x")/ruby/php file_put_contents|fopen) in
 * -c code AND heredoc bodies (literal targets resolved against every cd'ed cwd; a non-literal write in a
 * command naming AGENTS.md is refused), shell quote-split names ("AGENTS".md), and globs that can match
 * it (AGENTS.m*, A*S.md, [A]GENTS.md). Copy-OUT (AGENTS.md as a source) is allowed.
 * KNOWN BYPASSES (ledger-detected): script files (`python3 x.py`), $(…)/array/sourced indirection, symlinks
 * under another basename, names built at runtime inside interpreter code ('AGENTS' + '.md', globbing in
 * code), whole-tree git ops that never name
 * AGENTS.md, archive extraction, non-Pi writers.
 *
 * 01_Soul (request 2026-10-03 r2; incident 2026-10-02 06:21Z: an unratified `sed -i` sweep rewrote live
 * Active_Patterns.md and left `01_Soul/sed2K07vB`). Soul is L3 (AGENTS.md): ALWAYS ON for EVERY Pi role, foreground
 * included, no switch, no env bypass. The ratified route is a proposal in Automation/Soul_Proposed_Changes/ that the owner
 * applies from the Control Tower panel (control_tower/soul_apply.py, in-process — never a tool call). wisdom_guard.py
 * itself refuses every Soul write (rule S0) — the chokepoint; this guard only keeps its exact read/refusal form usable.
 * write/edit: Pi-identical path resolution + realpath of the nearest existing ancestor; every rclone mount of the drive.
 * bash: READER ALLOWLIST — a command touching a Soul path (operand, option value, redirect target, glob, or a Soul cwd)
 * is refused unless every simple command touching it is a known reader (cat/head/tail/grep/rg/sed without -i or w/e,
 * awk without -i/redirect/system, diff/cmp/wc/stat/ls/file/sha*sum, cp/rsync/tar FROM Soul to a non-Soul destination,
 * git log/show/diff/status). Substitutions, bash/sh -c, eval, xargs, find -exec and shell heredocs are analysed
 * recursively; interpreter code (python/node/perl/ruby, -c/-e/heredoc) is refused only when a write-mode call targets
 * Soul (string literals that merely MENTION Soul do not count). Ancestor shapes (rm -r/mv of a parent, rsync --delete,
 * a copied tree holding 01_Soul) are refused too. Writers outside Pi: fleet/soul_integrity.py (doctor drop-in, hourly).
 * KNOWN BYPASSES (detector-caught): script files fed paths at runtime, runtime-built names, symlinks made outside Pi.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const IS_BACKGROUND = process.env.WOS_BACKGROUND_AGENT === "1";
const WOS_ROOT = process.env.WISDOM_OS_ROOT || path.join(os.homedir(), "wisdom-os");
const SOUL_ROOT = path.resolve(WOS_ROOT, "Obsidian Vault", "Context", "01_Soul");
const BLOCK_LOG = process.env.WOS_PROTECTED_WRITE_LOG ||
  path.join(os.homedir(), ".wos-runtime", "butler", "state", "protected_write_blocks.jsonl");
const INBOX_WRITER = path.join(os.homedir(), ".wos-runtime", "kg", "inbox_schema.py");
const INBOX_PATH = process.env.WOS_PROTECTED_WRITE_INBOX || "";
const AGENT = process.env.WOS_AGENT_SLUG || "background-pi";
const AGENTS_MD = path.resolve(WOS_ROOT, "AGENTS.md");
const AGENTS_GATE = "agents-md-installer-only";
const AGENTS_INSTALLER = "~/.wos-runtime/harness/agents_md_install.py";

function under(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== "..");
}

function resolved(raw: unknown, cwd: string): string {
  const value = String(raw ?? "");
  return path.resolve(cwd || process.cwd(), value.replace(/^~(?=\/)/, os.homedir()));
}

function commandMentionsSoul(command: string): boolean {
  const expanded = command
    .replaceAll("${HOME}", os.homedir())
    .replaceAll("$HOME", os.homedir())
    .replaceAll("${WISDOM_OS_ROOT}", WOS_ROOT)
    .replaceAll("$WISDOM_OS_ROOT", WOS_ROOT);
  return expanded.includes(SOUL_ROOT);
}

// This is telemetry and early refusal, not the security boundary. The read-only mount catches
// indirect/dynamic writers too. Keep this conservative enough that read-only audits still work.
function bashLooksMutating(command: string): boolean {
  if (!commandMentionsSoul(command)) return false;
  const mutator = /(?:^|[;&|\n]\s*)(?:sudo\s+)?(?:cp|mv|rm|unlink|touch|truncate|install|rsync|ln|chmod|chown)\b/i;
  const inPlace = /\b(?:sed|perl)\s+[^\n;&|]*\s-(?:[^\s]*i[^\s]*)\b/i;
  const redirect = /(?:^|[^<])>>?\s*["']?(?:\/|\$\{?(?:HOME|WISDOM_OS_ROOT))/m;
  const pythonWrite = /(?:write_text|write_bytes|os\.replace|shutil\.(?:copy|copy2|move)|open\s*\([^\n]*(?:['"](?:w|a|x|r\+)['"]))/i;
  return mutator.test(command) || inPlace.test(command) || redirect.test(command) || pythonWrite.test(command);
}

function envelope(): Record<string, unknown> | null {
  const encoded = process.env.WOS_RETURN_ENVELOPE_B64 || "";
  if (!encoded) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function priorBlocks(): any[] {
  try {
    if (!fs.existsSync(BLOCK_LOG)) return [];
    return fs.readFileSync(BLOCK_LOG, "utf8").split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; }
}

function realOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}
let agentsMdReal: string | null = null;  // lazy: no FUSE syscall at load or on unrelated paths

// Only paths whose basename is AGENTS.md pay a realpath (dead-FUSE safety + zero cost elsewhere).
function isAgentsMd(candidate: string): boolean {
  if (candidate === AGENTS_MD) return true;
  if (path.basename(candidate) !== "AGENTS.md") return false;
  if (agentsMdReal === null) agentsMdReal = realOrSelf(AGENTS_MD);
  return realOrSelf(candidate) === agentsMdReal;
}

// ---- AGENTS.md bash detection: target-aware, so reading/copying AGENTS.md OUT stays allowed. ----
function expandVars(command: string): string {
  const vars: Record<string, string> = { HOME: os.homedir(), WISDOM_OS_ROOT: WOS_ROOT };
  const sub = (s: string) => s.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => vars[a || b] ?? m);
  // simple same-command assignments: W="$WISDOM_OS_ROOT"; X=/abs/path
  const assign = /(?:^|[;&|\n]\s*|\s)(?:export\s+)?([A-Za-z_]\w*)=("([^"]*)"|'([^']*)'|([^\s;&|]*))/g;
  let m: RegExpExecArray | null;
  while ((m = assign.exec(command)) !== null) {
    vars[m[1]] = m[3] !== undefined ? sub(m[3]) : m[4] !== undefined ? m[4] : sub(m[5] ?? "");
  }
  return sub(command);
}

// Minimal shell word splitter per simple command (quotes honoured; no globbing/expansion beyond vars).
function segments(command: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [], cur = "", q: string | null = null, has = false;
  const flushWord = () => { if (has) words.push(cur); cur = ""; has = false; };
  const flushSeg = () => { flushWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    // bash: inside "…" a backslash escapes " \ $ ` (request 2026-10-05: `python3 -c "os.system(\"sed -i …\")"`
    // used to END the quote at \", so the inline code reached the interpreter check mangled and passed)
    if (q === '"' && c === "\\" && i + 1 < command.length && /["\\$`]/.test(command[i + 1])) { cur += command[++i]; continue; }
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === "\\" && i + 1 < command.length) { cur += command[++i]; has = true; continue; }
    if (c === ">" || c === "<") {
      flushWord(); let op = c;
      while (command[i + 1] === ">" || command[i + 1] === "&" || (op === ">" && command[i + 1] === "|")) op += command[++i];
      words.push(op); continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "`") { flushSeg(); continue; }
    if (/\s/.test(c)) { flushWord(); continue; }
    cur += c; has = true;
  }
  flushSeg();
  return out;
}

// Interpreter write calls with a LITERAL target: [regex, index of target group(s)]. Sources (copy-out) are allowed.
const WRITE_CALLS: Array<[RegExp, number[]]> = [
  [/\bopen\s*\(\s*(['"`])([^'"`\n]+)\1\s*,\s*(?:mode\s*=\s*)?(['"])[^'"]*[wax+][^'"]*\3/g, [2]],
  [/\bPath\s*\(\s*(['"])([^'"\n]+)\1\s*\)\s*\.\s*(?:write_text|write_bytes|touch|unlink|rename|replace|open\s*\(\s*['"][^'"]*[wax+])/g, [2]],
  [/\bos\s*\.\s*(?:remove|unlink|truncate)\s*\(\s*(['"])([^'"\n]+)\1/g, [2]],
  [/\bos\s*\.\s*(?:replace|rename)\s*\(\s*(['"])([^'"\n]+)\1\s*,\s*(['"])([^'"\n]+)\3/g, [2, 4]],
  [/\bshutil\s*\.\s*move\s*\(\s*(['"])([^'"\n]+)\1\s*,\s*(['"])([^'"\n]+)\3/g, [2, 4]],
  [/\bshutil\s*\.\s*(?:copy2?|copyfile)\s*\(\s*(['"])[^'"\n]+\1\s*,\s*(['"])([^'"\n]+)\2/g, [3]],
  [/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|truncateSync|unlinkSync|rmSync|createWriteStream|Bun\.write)\s*\(\s*(['"`])([^'"`\n]+)\1/g, [2]],
  [/\b(?:renameSync|rename)\s*\(\s*(['"`])([^'"`\n]+)\1\s*,\s*(['"`])([^'"`\n]+)\3/g, [2, 4]],
  [/\b(?:copyFileSync|copyFile|cpSync)\s*\(\s*(['"`])[^'"`\n]+\1\s*,\s*(['"`])([^'"`\n]+)\2/g, [3]],
  [/\bopen\s*\(?\s*(?:my\s+)?[$\w]*\s*,\s*['"](?:>>?|\+<|\+>)['"]\s*,\s*['"]([^'"\n]+)['"]/g, [1]],
  [/\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*(['"])\s*(?:>>?|\+<|\+>)\s*([^'"\n]+)\1/g, [2]],      // perl 2-arg open(F, ">x")
  [/\bfile_put_contents\s*\(\s*(['"])([^'"\n]+)\1/g, [2]],                                         // php
  [/\bfopen\s*\(\s*(['"])([^'"\n]+)\1\s*,\s*['"][^'"]*[waxc+][^'"]*['"]/g, [2]],
  [/\b(?:unlink|touch|truncate)\s*\(\s*(['"])([^'"\n]+)\1/g, [2]],
  [/\bcopy\s*\(\s*(['"])[^'"\n]+\1\s*,\s*(['"])([^'"\n]+)\2/g, [3]],
];
// Any write-capable call at all (used only when AGENTS.md is mentioned and no literal target explains it).
const ANY_WRITE = /(?:write_text|write_bytes|os\s*\.\s*(?:replace|rename|remove|unlink)|shutil\s*\.\s*(?:copy|copy2|copyfile|move)|\bopen\s*\([^,)\n]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+][^'"]*['"]|writeFileSync|appendFileSync|renameSync|copyFileSync|createWriteStream|Bun\.write|unlinkSync|rmSync|file_put_contents|\bfopen\s*\([^,)\n]*,\s*['"][^'"]*[waxc+]|\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*['"]\s*(?:>>?|\+<|\+>))/;
const INTERP = /(?:^|[\s;&|(`])(?:\S*\/)?(?:python\d*(?:\.\d+)?|fbpython|node|bun|deno|perl|ruby|php)\b/;
const EDITORS = new Set(["vi", "vim", "nvim", "nano", "emacs", "ed", "ex", "pico", "micro", "joe", "code"]);
const MUTATORS = new Set(["rm", "unlink", "truncate", "touch", "chmod", "chown", "shred", "mv", "cp", "install", "tee", "sed", "perl", "dd", "ln", "rsync"]);

// Could shell glob `w` (relative to cwd) match the root AGENTS.md? Pure pattern test, no filesystem walk.
function globHitsAgentsMd(w: string, cwd: string): boolean {
  const abs = resolved(w, cwd);
  if (path.dirname(abs) !== path.dirname(AGENTS_MD) || /[*?[]/.test(path.dirname(abs))) {
    // a glob in the directory part: match the whole path pattern
    const rxAll = new RegExp("^" + abs.split("/").map(globRx).join("/") + "$");
    return rxAll.test(AGENTS_MD);
  }
  return new RegExp("^" + globRx(path.basename(abs)) + "$").test("AGENTS.md");
}
function globRx(seg: string): string {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const j = seg.indexOf("]", i + 1);
      const cls = j > i ? "[" + seg.slice(i + 1, j).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]" : "";
      // request 2026-10-03: an invalid class (e.g. `[slow-first]`, range out of order) used to THROW
      // out of tool_call, which Pi turns into an error result — a legit command failed. Bash treats it literally.
      let valid = false;
      if (cls) { try { new RegExp(cls); valid = true; } catch { /* literal */ } }
      if (valid) { out += cls; i = j; } else out += "\\[";
    }
    else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return out;
}

function bashTouchesAgentsMd(command: string, cwd0: string, depth = 0): boolean {
  // fast path: zero parsing unless the de-quoted text names AGENTS, or a glob could reach the root
  const flat = command.replace(/["'\\]/g, "");
  const root = path.dirname(AGENTS_MD);
  const globby = /[*?[]/.test(command) && (cwd0 === root || flat.includes(root) || /Wisdom OS|WISDOM_OS_ROOT|\bcd\b/.test(flat));
  if (!flat.includes("AGENTS") && !globby) return false;
  const expanded = expandVars(command);
  let cwd = cwd0;
  const cwds = new Set<string>([cwd0]);
  const isGlob = (w: string) => /[*?[]/.test(w);
  const hit = (w: string) => isGlob(w) ? globHitsAgentsMd(w, cwd) : /AGENTS\.md/.test(w) && isAgentsMd(resolved(w, cwd));
  const hitAny = (w: string) => /AGENTS\.md/.test(w) && [...cwds].some((c) => isAgentsMd(resolved(w, c)));
  const covers = (dir: string) => { const r = path.relative(dir, root); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  for (const words0 of segments(expanded)) {
    let words = words0;
    while (words.length && /^(?:sudo|env|command|nohup|time|nice|timeout|stdbuf|[A-Za-z_]\w*=.*)$/.test(words[0])) {
      words = words[0] === "timeout" ? words.slice(2) : words.slice(1);
    }
    if (!words.length) continue;
    if (words[0] === "cd" || words[0] === "pushd") { if (words[1]) { cwd = resolved(words[1], cwd); cwds.add(cwd); } continue; }
    for (let i = 0; i < words.length; i++) {  // redirections: > >> >| &> 2> …
      if (/^\d*>{1,2}[&|]?$|^&>>?$/.test(words[i]) && words[i + 1] && hit(words[i + 1])) return true;
    }
    const cmd = path.basename(words[0]);
    const args = words.slice(1).filter((w) => !/^[<>]/.test(w));
    const operands = args.filter((w) => !w.startsWith("-"));
    if (["bash", "sh", "zsh", "dash", "ksh"].includes(cmd) && depth < 3) {
      const ci = args.findIndex((w) => /^-\w*c\w*$/.test(w));
      if (ci >= 0 && args[ci + 1] && bashTouchesAgentsMd(args[ci + 1], cwd, depth + 1)) return true;
    }
    if (cmd === "eval" && depth < 3 && bashTouchesAgentsMd(args.join(" "), cwd, depth + 1)) return true;
    if (cmd === "tee" && operands.some(hit)) return true;
    if ((cmd === "sed" || cmd === "perl") && args.some((w) => /^-[^-]*i/.test(w) || w.startsWith("--in-place")) && operands.some(hit)) return true;
    if ((cmd === "awk" || cmd === "gawk") && (args.some((w, i) => (w === "-i" && args[i + 1] === "inplace") || w === "-iinplace" || w === "--include=inplace")) && operands.some(hit)) return true;
    if (["rm", "unlink", "truncate", "touch", "chmod", "chown", "shred"].includes(cmd) && operands.some(hit)) return true;
    if (cmd === "mv" && operands.some(hit)) return true;  // moving it away or onto it
    if (EDITORS.has(cmd) && operands.some(hit)) return true;
    if (cmd === "git" && operands.some(hit) &&
        operands.some((w) => ["checkout", "restore", "rm", "mv", "stash", "apply", "reset", "switch"].includes(w))) return true;
    if (cmd === "find" && args.some((w) => /^-(?:delete|exec|execdir|ok|okdir|fprint)/.test(w))) {
      const starts = operands.filter((w) => !/AGENTS\.md/.test(w) || hit(w)).slice(0, 1);
      const start = starts.length ? resolved(starts[0], cwd) : cwd;
      if (covers(start) || isAgentsMd(start)) return true;
    }
    if (cmd === "xargs" && words.slice(1).some((w) => MUTATORS.has(path.basename(w)))) {
      if (expanded.includes(AGENTS_MD) || covers(cwd)) return true;
    }
    if (["cp", "install", "rsync", "ln", "dd"].includes(cmd)) {
      if (cmd === "dd" && args.some((w) => w.startsWith("of=") && hit(w.slice(3)))) return true;
      const tIdx = args.findIndex((w) => w === "-t" || w === "--target-directory");
      const dest = tIdx >= 0 ? args[tIdx + 1] : operands[operands.length - 1];
      if (dest && operands.length >= 2 && hit(dest)) return true;
      if (dest && operands.length >= 2 && path.resolve(cwd, dest) === root &&
          operands.slice(0, -1).some((w) => path.basename(w) === "AGENTS.md")) return true;
    }
  }
  // Interpreter writes (inline -c/-e code AND heredoc bodies): scan the raw text, cwd-aware, relative paths too.
  if (INTERP.test(expanded)) {
    let rest = expanded;
    for (const [rx, groups] of WRITE_CALLS) {
      rx.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(expanded)) !== null) {
        if (groups.some((g) => m![g] && hitAny(m![g]))) return true;
        rest = rest.replace(m[0], " ".repeat(m[0].length));  // explained: literal, not AGENTS.md
      }
    }
    // a write whose target is not a literal, in a command that names AGENTS.md → cannot prove safe
    if (ANY_WRITE.test(rest)) {
      const names = expanded.includes(AGENTS_MD) || [...cwds].some((c) => c === root && /(?:^|[^\w/.-])AGENTS\.md/.test(expanded));
      if (names) return true;
    }
  }
  return false;
}

function refuseAgentsMd(toolName: string, target: string) {
  const reason = `AGENTS.md is installer-only (the owner Q9 2026-09-26). Draft a candidate file elsewhere; DIR-wos verifies it and installs with ${AGENTS_INSTALLER} apply. Direct ${toolName} was not run.`;
  recordAndReport(toolName, target, reason, AGENTS_GATE);
  return { block: true, reason };
}

// ---- 01_Soul: always on, every role, every tool (request 2026-10-03) ----
const SOUL_GATE = "soul-ratified-route-only";
export const SOUL_STAGE_CMD = "/usr/bin/python3 ~/.wos-runtime/fleet/soul_propose.py stage --target <Soul file, e.g. Active_Patterns.md> " +
  "--anchor '<exact existing line to insert after>' --text-file <draft.md> --approval '<the owner verbatim + date>' --slug <slug> --apply";
const SOUL_ROUTE = "Soul is L3: only the owner ratifies it (AGENTS.md). Stage it: " + SOUL_STAGE_CMD +
  " — then the owner clicks Accept on that row in the Control Tower proposals panel (anchor field = the printed anchor); " +
  "the server applies it and logs it in control_tower/state/soul_apply_log.jsonl.";
const SOUL_PROPOSE = path.join(os.homedir(), ".wos-runtime", "fleet", "soul_propose.py");
const SOUL_SANDBOX_SH = path.join(os.homedir(), ".wos-runtime", "butler", "soul_sandbox.sh");
/** An installed tool that only READS Soul (exact path, lexically and by realpath — never a staging copy). */
function isSoulReaderTool(p: string, cwd: string): boolean {
  const abs = resolved(p, cwd);
  return [SOUL_PROPOSE, SOUL_SANDBOX_SH].some((t) => abs === t && realOrSelf(abs) === realOrSelf(t));
}
const SOUL_TAIL = path.join("Wisdom OS", "Obsidian Vault", "Context", "01_Soul");
const WISDOM_GUARD = path.join(os.homedir(), ".wos-runtime", "wisdom_guard.py");

/** Every path at which canonical Soul is reachable: the configured root + the same tree under each rclone mount. */
/** Every path at which canonical Soul is reachable (r5, P0 2026-10-03 12:12:58Z alias incident): the configured
 *  root, the same filesystem path through EVERY mount of the same filesystem (same major:minor in mountinfo — bind /
 *  propagated mounts, e.g. /srv/users/<u>/sync-home/wisdom-os ≡ ~/wisdom-os) or of the same FUSE remote, plus the old
 *  rclone-mount ∪ tail rule. Lexical only — no FUSE syscall at load (a dead mount must not hang Pi start). */
export function soulRoots(mountinfoText?: string): string[] {
  const roots = new Set<string>([SOUL_ROOT]);
  let text = mountinfoText;
  if (text === undefined) { try { text = fs.readFileSync("/proc/self/mountinfo", "utf8"); } catch { text = ""; } }
  const dec = (x: string) => x.replace(/\\([0-7]{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));
  const mounts: Array<[string, string, string, string, string]> = [];
  for (const line of text.split("\n")) {
    const [left, right] = line.split(" - ");
    if (!right) continue;
    const f = left.split(" "), r = right.split(" ");
    if (f.length >= 5 && r.length >= 2) mounts.push([f[2], dec(f[3]), dec(f[4]), r[0], r[1]]);
  }
  const inside = (p: string, root: string) => p === root || p.startsWith(root.replace(/\/+$/, "") + "/");
  const home = mounts.filter((m) => inside(SOUL_ROOT, m[2]));
  if (home.length) {
    const mm = home.reduce((a, b) => (b[2].length > a[2].length ? b : a));
    const fsPath = path.posix.normalize(path.posix.join(mm[1], path.relative(mm[2], SOUL_ROOT)));
    for (const e of mounts) {
      const sameFs = e[0] === mm[0] || (e[3] === mm[3] && e[4] === mm[4] && e[3].startsWith("fuse"));
      if (sameFs && inside(fsPath, e[1])) roots.add(path.posix.normalize(path.posix.join(e[2], path.posix.relative(e[1], fsPath))));
    }
  }
  for (const e of mounts) if (e[3] === "fuse.rclone") roots.add(path.join(e[2], SOUL_TAIL));
  return [...roots];
}
const SOUL_ROOTS = soulRoots();
let soulRealRoots: string[] | null = null;  // lazy: realpath only when a write/edit actually needs it

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;  // pi.real normalizePath, verbatim (see wos-soul-guard.ts)
/** Resolve a write/edit path exactly like Pi's own tools: `@` prefix, no-break spaces, `~`, file:// URLs. */
function piResolve(raw: unknown, cwd: string): string {
  let p = String(raw ?? "").replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  if (/^file:\/\//.test(p)) { try { p = fileURLToPath(p); } catch { /* Pi errors out too */ } }
  return path.resolve(cwd || process.cwd(), p);
}
/** realpath of the nearest existing ancestor + the not-yet-existing remainder (where the write would land). */
function realThrough(abs: string): string {
  const rest: string[] = [];
  let cur = abs;
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* walk up */ }
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.push(path.basename(cur));
    cur = up;
  }
  return abs;
}
function lexicallyInSoul(abs: string): boolean { return SOUL_ROOTS.some((r) => under(abs, r)); }
/** write/edit target: lexical OR real (symlinked file/dir) landing inside any Soul root. */
let soulDirIds: Set<string> | null = null;   // "dev:ino" of every 01_Soul dir on every alias (lazy, first write/edit)
function soulIds(): Set<string> {
  if (soulDirIds) return soulDirIds;
  const ids = new Set<string>();
  const walk = (d: string, depth: number) => {
    try { const st = fs.statSync(d); ids.add(`${st.dev}:${st.ino}`); } catch { return; }
    if (depth >= 4) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
        else if (e.isFile()) { try { const st = fs.statSync(path.join(d, e.name)); ids.add(`${st.dev}:${st.ino}`); } catch { /* raced */ } }
      }
    } catch { /* unreadable */ }
  };
  for (const r of SOUL_ROOTS) walk(r, 0);
  soulDirIds = ids;
  return ids;
}
/** write/edit target: lexical OR real (symlinked file/dir) landing inside any Soul alias root, OR any existing
 *  ancestor carrying the (dev, ino) of a 01_Soul directory (an alias no mount table explains). */
export function toolTargetInSoul(raw: unknown, cwd: string): string | null {
  const abs = piResolve(raw, cwd);
  if (lexicallyInSoul(abs)) return abs;
  const real = realThrough(abs);
  if (real !== abs) {
    if (lexicallyInSoul(real)) return real;
    if (soulRealRoots === null) soulRealRoots = SOUL_ROOTS.map(realOrSelf);
    if (soulRealRoots.some((r) => under(real, r))) return real;
  }
  const ids = soulIds();
  try { const st = fs.statSync(abs); if (ids.has(`${st.dev}:${st.ino}`)) return real; } catch { /* new file */ }
  let cur = path.dirname(real);
  for (let i = 0; i < 64; i++) {
    try { const st = fs.statSync(cur); if (ids.has(`${st.dev}:${st.ino}`)) return real; } catch { /* not yet existing */ }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

type Rel = "in" | "anc" | null;
/** Where does shell word `w` (cwd-relative, maybe a glob) land relative to Soul: inside it, an ancestor of it, or neither. */
function soulRel(w: string, cwd: string): Rel {
  if (!w || /^-/.test(w)) return null;
  const abs = resolved(w, cwd);
  let best: Rel = null;
  for (const root of SOUL_ROOTS) {
    let r: Rel = null;
    if (!/[*?[]/.test(abs)) {
      r = under(abs, root) ? "in" : under(root, abs) ? "anc" : null;
    } else {
      const p = abs.split("/"), s = root.split("/");
      let ok = true;
      for (let i = 0; i < Math.min(p.length, s.length) && ok; i++) ok = new RegExp("^" + globRx(p[i]) + "$").test(s[i]);
      r = ok ? (p.length >= s.length ? "in" : "anc") : null;
    }
    if (r === "in") return "in";
    if (r === "anc") best = "anc";
  }
  // r5: a local-disk path may be a SYMLINK alias into Soul (/tmp/s -> …/01_Soul). Realpath only off the wisdom-os mounts
  // (local fs: cheap, cannot hang on a dead FUSE) and only for plain (non-glob) words; cached per word.
  if (best === null && !/[*?[]/.test(abs) && !GDRIVE_MOUNTS.some((m) => under(abs, m))) {
    let real = REAL_CACHE.get(abs);
    if (real === undefined) { real = realThrough(abs); if (REAL_CACHE.size > 5000) REAL_CACHE.clear(); REAL_CACHE.set(abs, real); }
    if (real !== abs) return soulRel(real, "/");
  }
  return best;
}
const REAL_CACHE = new Map<string, string>();
const GDRIVE_MOUNTS: string[] = (() => {
  try {
    return fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter((l) => / - fuse/.test(l))
      .map((l) => l.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)))).filter(Boolean) as string[];
  } catch { return []; }
})();

// ===================== bash: READER ALLOWLIST (r2, DIR-wos ruling 2026-10-03) =====================
// Any shell command that touches a 01_Soul path is REFUSED unless every simple command touching it is a known
// reader. "Touches" = an operand / option value / redirect target / glob resolving into Soul, or the command runs
// with its cwd inside Soul. Substitutions ($(…), `…`, <(…), >(…)), bash/sh -c strings, eval, xargs and find -exec
// payloads, and shell heredoc bodies are analysed RECURSIVELY (never masked). Interpreter code (python/node/perl/
// ruby/php, -c/-e or a heredoc) is judged by its write-mode calls: refused only when a write target resolves into Soul.
const SOUL_P = () => path.join(SOUL_ROOT, "Active_Patterns.md");
const PURE_READERS = new Set(["cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "diff", "cmp", "wc", "stat", "ls", "file",
  "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "md5sum", "b2sum", "cksum", "realpath", "readlink", "basename",
  "dirname", "du", "test", "[", "echo", "printf", "true", "false", "pwd", "nl", "od", "xxd", "hexdump", "strings", "cd", "pushd", "popd",
  "cut", "tr", "tac", "rev", "paste", "fold", "expand", "unexpand", "column", "fmt", "iconv", "base64", "jq", "comm", "join", "seq",
  "date", "sleep", "printenv", "id", "whoami", "hostname", "uname", "nproc", "ps", "env", "which", "type", "command", "getfacl", "lsattr",
  "zcat", "zgrep", "bzcat", "xzcat", "zstdcat", "tiktoken"]);
const GIT_READ = new Set(["log", "show", "diff", "status", "blame", "ls-files", "grep", "rev-parse", "cat-file"]);
const INTERP_RX = /^(?:python\d*(?:\.\d+)?|fbpython|node|bun|deno|perl|ruby|php)$/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const PREFIX_RX = /^(?:sudo|env|command|builtin|exec|nohup|time|nice|ionice|timeout|stdbuf|flock|do|then|else|elif|if|while|until|!|\{|[A-Za-z_]\w*=.*)$/;
const UNIT_RX = /^\u0002(\d+)\u0002$/;          // a placeholder for an extracted substitution

/** Split heredoc bodies out of a command: the shell text keeps the operator line; bodies are returned separately. */
function splitHeredocs(text: string): { shell: string; bodies: { head: string; body: string; quoted: boolean }[] } {
  const lines = text.split("\n");
  const out: string[] = [], bodies: { head: string; body: string; quoted: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const ops = [...line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g)].filter((m) => line[m.index! - 1] !== "<" && line[m.index! + 2] !== "<");
    for (const m of ops) {
      const strip = m[1] === "-", delim = m[3], body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if ((strip ? lines[j].replace(/^\t+/, "") : lines[j]) === delim) break;
        body.push(lines[j]);
      }
      bodies.push({ head: line, body: body.join("\n"), quoted: m[2] !== "" });
      i = Math.min(j, lines.length - 1);
    }
  }
  return { shell: out.join("\n"), bodies };
}

/** Pull out $(…), `…`, <(…), >(…) (nesting- and quote-aware; nothing inside '…' is a substitution). */
function extractSubst(text: string): { shell: string; units: string[] } {
  const units: string[] = [];
  let out = "", i = 0, sq = false, dq = false;
  while (i < text.length) {
    const c = text[i];
    if (sq) { out += c; if (c === "'") sq = false; i++; continue; }
    if (c === "\\" && i + 1 < text.length) { out += c + text[i + 1]; i += 2; continue; }
    if (c === "'" && !dq) { sq = true; out += c; i++; continue; }
    if (c === '"') { dq = !dq; out += c; i++; continue; }
    const open = (c === "$" || c === "<" || c === ">") && text[i + 1] === "(";
    if (open || c === "`") {
      let j = i + (c === "`" ? 1 : 2), depth = 1, q: string | null = null;
      const start = j;
      for (; j < text.length; j++) {
        const d = text[j];
        if (q) { if (d === "\\" && q === '"') { j++; continue; } if (d === q) q = null; continue; }
        if (d === "\\") { j++; continue; }
        if (c === "`") { if (d === "`") break; continue; }
        if (d === "'" || d === '"') { q = d; continue; }
        if (d === "(") depth++;
        else if (d === ")" && --depth === 0) break;
      }
      units.push(text.slice(start, j));
      out += (c === ">" ? "" : "") + `\u0002${units.length - 1}\u0002`;
      i = j + 1;
      continue;
    }
    out += c; i++;
  }
  return { shell: out, units };
}

// ---- interpreter code: mask string literals, then judge write-mode calls by the ROOT of their target expression ----
function maskLiterals(code: string, lang: "py" | "js" | "pl"): { m: string; lits: string[] } {
  const lits: string[] = [];
  const out: string[] = [];                    // chunks (never re-scan or re-slice the growing buffer: O(n))
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if ((lang === "py" || lang === "pl") && c === "#") { while (i < code.length && code[i] !== "\n") i++; continue; }
    if (lang === "js" && c === "/" && code[i + 1] === "/") { while (i < code.length && code[i] !== "\n") i++; continue; }
    if (lang === "js" && c === "/" && code[i + 1] === "*") { const e = code.indexOf("*/", i + 2); i = e < 0 ? code.length : e + 2; continue; }
    if (c === "'" || c === '"' || (c === "`" && lang === "js")) {
      const triple = lang === "py" && code.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      let j = i + close.length;
      const val: string[] = [];
      while (j < code.length && !code.startsWith(close, j)) {
        if (code[j] === "\\" && j + 1 < code.length) { val.push(code[j + 1]); j += 2; continue; }
        if (!triple && c !== "`" && code[j] === "\n") break;
        val.push(code[j]); j++;
      }
      // a string prefix (r, b, f, u, rb, fr …) sticks to the literal: those chars were copied one by one just before
      const pm = /[rRbBuUfF]{1,2}$/.exec(code.slice(Math.max(0, i - 2), i));
      if (pm && !/\w/.test(code[i - pm[0].length - 1] ?? "")) out.splice(out.length - pm[0].length, pm[0].length);
      lits.push(val.join(""));
      out.push(`\u0001${lits.length - 1}\u0001`);
      i = j + close.length;
      continue;
    }
    out.push(c); i++;
  }
  return { m: out.join(""), lits };
}
const ROOTISH = new RegExp("(?:^|[\\s'\"`(,=])(?:~|" + os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
  "|/srv/users/[^/'\"`]+/sync-home)/wisdom-os\\b|WISDOM_OS_ROOT|expanduser\\(\\s*['\"]~['\"/]|Path\\.home\\(\\)|os\\.environ\\[['\"]HOME['\"]\\]|getenv\\(\\s*['\"]HOME");
const SHELL_OUT = /\b(?:subprocess\s*\.\s*\w+|os\s*\.\s*(?:system|popen|exec\w*|spawn\w*)|Popen|execSync|spawnSync|execFileSync|exec|spawn|system)\s*\(/g;
const SHELL_MUT = /(?:^|[\s'"`,\[(])(?:-i|--in-place|-pi|rm|mv|cp|tee|truncate|install|rsync|dd|unlink|ln|touch|chmod|shred)(?=[\s'"`,\])]|$)/;
// Write calls, each with the argument(s) that name the TARGET.
const TARGET_CALLS: Array<[RegExp, "first" | "dest" | "both" | "recv" | "pyopen" | "perlopen" | "recvopen" | "fileinput"]> = [
  [/\b(?:fileinput\s*\.\s*)?(?:input|FileInput)\s*\((?=[^\n;]*\binplace\s*=\s*(?!False\b|0\b|None\b))/g, "fileinput"],   // python fileinput in-place (request 2026-10-05)
  [/(?<![.\w$])open\s*\(/g, "pyopen"],                                            // python/ruby open(path, mode)
  [/(?<![.\w$])(?:sysopen|open)\s*\(?\s*(?:my\s+)?[$\w]+\s*,/g, "perlopen"],        // perl open(F, ">x") / 3-arg
  [/\bos\s*\.\s*(?:remove|unlink|truncate|rmdir|removedirs|makedirs|mkdir|open|chmod|chown|utime|mkfifo|mknod)\s*\(/g, "first"],
  [/\bshutil\s*\.\s*(?:rmtree|chown)\s*\(/g, "first"],
  [/\b(?:shutil\s*\.\s*(?:copy2?|copyfile|copytree|copymode|copystat)|copyFileSync|copyFile|cpSync|cp)\s*\(/g, "dest"],
  [/\b(?:shutil\s*\.\s*move|os\s*\.\s*(?:replace|rename|renames|link|symlink)|renameSync|rename|linkSync|symlinkSync)\s*\(/g, "both"],
  [/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|truncateSync|truncate|unlinkSync|unlink|rmSync|rm|rmdirSync|rmdir|mkdirSync|mkdir|createWriteStream|openSync|chmodSync|utimesSync|Bun\s*\.\s*write|file_put_contents|fopen|touch|File\s*\.\s*(?:write|open|delete|rename|unlink))\s*\(/g, "first"],
  [/\.\s*(?:write_text|write_bytes|touch|unlink|rename|replace|mkdir|rmdir|symlink_to|hardlink_to|chmod|lchmod)\s*\(/g, "recv"],
  [/\.\s*open\s*\(/g, "recvopen"],
];
function topArgs(s: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const c of s) {
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
function receiverOf(line: string, idx: number): string {
  let depth = 0, i = idx - 1;
  for (; i >= 0; i--) {
    const c = line[i];
    if (c === ")" || c === "]") depth++;
    else if (c === "(" || c === "[") { if (depth === 0) break; depth--; }
    else if (depth === 0 && (c === "=" || c === "," || c === ";" || c === ":")) break;
  }
  return line.slice(i + 1, idx);
}
type Head = { lit?: string; name?: string };
const WRAPPER = /^\s*(?:[([]\s*)*(?:(?:os\s*\.\s*path\s*\.\s*(?:join|abspath|realpath|expanduser|normpath)|(?:pathlib\s*\.\s*)?Path|PurePath|str|os\s*\.\s*fspath|path\s*\.\s*(?:join|resolve)|join|resolve|glob\s*\.\s*i?glob|sorted|list|reversed|set|tuple|File\s*\.\s*join)\s*\(\s*)/;
function headOf(expr: string, lits: string[]): Head {
  let e = expr;
  for (let k = 0; k < 6; k++) { const m = WRAPPER.exec(e); if (!m || !m[0]) break; e = e.slice(m[0].length); }
  e = e.replace(/^\s*[([]\s*/, "").trim();
  const lit = /^\u0001(\d+)\u0001/.exec(e);
  if (lit) {
    const v = lits[+lit[1]] ?? "";
    const brace = /^\{([A-Za-z_]\w*)\}/.exec(v) || /^\$\{([A-Za-z_]\w*)\}/.exec(v) || /^\$([A-Za-z_]\w*)/.exec(v);
    return brace ? { name: brace[1] } : { lit: v };
  }
  const id = /^\$?([A-Za-z_]\w*)/.exec(e);
  return id ? { name: id[1] } : {};
}
/** Does interpreter code write into the REAL Soul? Only write-mode calls count; a literal that merely MENTIONS Soul does not. */
export function interpWritesSoul(code: string, lang: "py" | "js" | "pl", cwds: string[], depth = 0, argvSoul = false): boolean {
  const { m, lits } = maskLiterals(code, lang);
  const unmask = (s: string) => s.replace(/\u0001(\d+)\u0001/g, (_x, n) => `'${lits[+n]}'`);
  const lines = m.split(/\n|;/);
  const inSoul = (lit: string) => cwds.some((c) => soulRel(lit, c) === "in");
  const ASSIGN = /^\s*(?:(?:const|let|var|my|our|local|export)\s+)?\$?([A-Za-z_]\w*)\s*(?::\s*[\w.\[\]]+\s*)?=(?![=~])\s*(.+)$|^\s*for\s+(?:(?:const|let|var|my)\s+)?\$?([A-Za-z_]\w*)\s+(?:in|of)\s+(.+?):?\s*\)?\s*\{?\s*$/;
  const roots = new Set<string>(), souls = new Set<string>();
  const rootish = (h: Head) => (h.lit !== undefined && ROOTISH.test(" " + h.lit)) || (h.name !== undefined && roots.has(h.name));
  // r5 (FP1): with a Soul path in argv/env, a target is Soul-bound only if it DERIVES from argv/env (directly or via a
  // variable assigned from them), or its root is UNKNOWN (a name never assigned in this code, a call result …).
  // A literal target, or one rooted at a known non-Soul variable, still passes.
  const ARGV = /\bsys\s*\.\s*argv\b|\bprocess\s*\.\s*argv\b|\bos\s*\.\s*environ\b|\b(?:os\s*\.\s*)?getenv\b|\bprocess\s*\.\s*env\b|[@$]ARGV\b|\$ENV\b|\bENV\s*\[|\bARGV\s*\[|\bfileinput\b|\bsys\s*\.\s*stdin\b/;
  const assigned = new Set<string>();
  if (argvSoul) for (const l of lines) { const a = ASSIGN.exec(l); if (a) assigned.add(a[1] ?? a[3]); }
  const soulExpr = (expr: string): boolean => {
    const h = headOf(expr, lits);
    const txt = unmask(expr);
    if (argvSoul) {
      if (ARGV.test(expr)) return true;
      if (h.lit === undefined && h.name === undefined && expr.trim()) return true;           // call result etc.: unknown
      if (h.name !== undefined && !assigned.has(h.name) && !/^(?:Path|pathlib|os|path|File|Dir|process|self|open)$/.test(h.name)) return true;
    }
    if (h.lit !== undefined) {
      if (h.lit.includes("01_Soul") && (inSoul(h.lit) || ROOTISH.test(" " + h.lit))) return true;
      return ROOTISH.test(" " + h.lit) && txt.includes("01_Soul");
    }
    if (h.name !== undefined && /^(?:Path|pathlib|os|path|File|Dir|process)$/.test(h.name))   // Path.home() / … module roots
      return ROOTISH.test(" " + txt) && txt.includes("01_Soul");
    if (h.name !== undefined) return souls.has(h.name) || (roots.has(h.name) && txt.includes("01_Soul"));
    return false;
  };
  // pre-pass: names whose EVERY assignment is Soul-bound are Soul from the start (a def before the assignment)
  const verdict = new Map<string, boolean>();
  for (let pass = 0; pass < 3; pass++) {
    for (const l of lines) {
      const a = ASSIGN.exec(l); if (!a) continue;
      const name = a[1] ?? a[3], rhs = a[2] ?? a[4];
      if (rootish(headOf(rhs, lits)) || ROOTISH.test(" " + unmask(rhs).slice(0, 160))) roots.add(name);
      verdict.set(name, (verdict.get(name) ?? true) && soulExpr(rhs));
    }
  }
  const always = new Set([...verdict].filter(([, v]) => v).map(([n]) => n));
  for (const n of always) souls.add(n);
  for (const l of lines) {
    const a = ASSIGN.exec(l);
    if (a) {
      const name = a[1] ?? a[3], rhs = a[2] ?? a[4];
      if (soulExpr(rhs)) souls.add(name); else if (!always.has(name)) souls.delete(name);
    }
    SHELL_OUT.lastIndex = 0;
    let so: RegExpExecArray | null;
    while ((so = SHELL_OUT.exec(l)) !== null) {
      const args = topArgs(l.slice(so.index + so[0].length));
      const lit0 = /^\s*\u0001(\d+)\u0001\s*$/.exec(args[0] ?? "");
      if (lit0 && depth < 3 && bashTouchesSoul(lits[+lit0[1]], cwds[0] ?? "/", depth + 1)) return true;   // os.system("sed -i …")
      const flatArgs = l.slice(so.index).split(/[,\[\]()]/).map((x) => x.trim()).filter(Boolean);
      if (SHELL_MUT.test(unmask(l.slice(so.index))) && flatArgs.some((x) => soulExpr(x))) return true;
    }
    for (const [rx, which] of TARGET_CALLS) {
      rx.lastIndex = 0;
      let c: RegExpExecArray | null;
      while ((c = rx.exec(l)) !== null) {
        if (which === "recv") { if (soulExpr(receiverOf(l, c.index))) return true; continue; }
        const args = topArgs(l.slice(c.index + c[0].length));
        if (which === "pyopen" || which === "recvopen") {
          const target = which === "recvopen" ? receiverOf(l, c.index) : args[0];
          const modeArgs = which === "recvopen" ? args : args.slice(1);
          const mode = modeArgs.find((x, i) => i === 0 ? !/^\s*\w+\s*=/.test(x) || /^\s*mode\s*=/.test(x) : /^\s*mode\s*=/.test(x));
          const mv = mode ? unmask(mode).replace(/^\s*mode\s*=\s*/, "") : "";
          if (/^\s*'[^']*[wax+][^']*'\s*$/.test(mv) && soulExpr(target ?? "")) return true;
          continue;
        }
        if (which === "fileinput") {
          // targets: the first positional arg or files=…; none ⇒ sys.argv[1:] (Soul-bound iff argv names Soul)
          const pos = args.filter((x) => x.trim() && !/^\s*\w+\s*=/.test(x));
          const kw = args.find((x) => /^\s*files\s*=/.test(x));
          const tgt = kw ? kw.replace(/^\s*files\s*=\s*/, "") : pos[0];
          if (tgt === undefined ? argvSoul : (soulExpr(tgt) || topArgs(tgt.replace(/^\s*[\[(]\s*/, "")).some((x) => soulExpr(x)))) return true;
          continue;
        }
        if (which === "perlopen") {
          const rest = args.map(unmask).join(",");
          const two = /'\s*(?:\+?[<>]{1,2}|\+<)\s*([^']+)'/.exec(rest);
          if (two && two[1] && (inSoul(two[1]) || (ROOTISH.test(" " + two[1]) && two[1].includes("01_Soul")))) return true;
          if (/'\s*(?:\+?>{1,2}|\+<)\s*'/.test(rest) && args.slice(1).some((x) => soulExpr(x))) return true;
          continue;
        }
        const pick = which === "first" ? args.slice(0, 1) : which === "dest" ? args.slice(1, 2) : args.slice(0, 2);
        if (pick.some((x) => soulExpr(x))) return true;
      }
    }
  }
  return false;
}
const langOf = (x: string): "py" | "js" | "pl" => /^(?:node|bun|deno)$/.test(x) ? "js" : /^(?:perl|ruby|php)$/.test(x) ? "pl" : "py";

/** find -exec / xargs payload: run with `{}`/$1/$@ (or the appended inputs) bound to a Soul path, is it still a reader? */
function payloadWritesSoul(sub: string[], cwd: string, depth: number): boolean {
  if (!sub.length) return false;
  if (depth >= 4) return true;
  const P = SOUL_P();
  const q = (w: string) => `'${w.replace(/'/g, "'\\''")}'`;
  const x = path.basename(sub[0]);
  if (SHELLS.has(x)) {
    const ci = sub.findIndex((w) => /^-\w*c\w*$/.test(w));
    if (ci < 0 || !sub[ci + 1]) return true;                                    // a script file: cannot see into it
    const script = sub[ci + 1].split("{}").join(q(P)).replace(/"?\$(?:\{?[1-9@*]\}?)"?/g, q(P));
    return bashTouchesSoul(script, cwd, depth + 1);
  }
  const bound = sub.map((w) => w.split("{}").join(P));
  if (!bound.slice(1).some((w) => w.includes(P))) bound.push(P);               // `+` / xargs append the paths
  return bashTouchesSoul(bound.map(q).join(" "), cwd, depth + 1);
}

/** Mark bare ( … ) subshell groups (outside quotes) so the segment walk can scope `cd` to them. */
function markSubshells(text: string): string {
  let out = "", sq = false, dq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) { out += c + text[++i]; continue; }
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq && c === "(") { out += " ; __PUSH__ ; "; continue; }
    else if (!sq && !dq && c === ")") { out += " ; __POP__ ; "; continue; }
    out += c;
  }
  return out;
}

/** expandVars for the Soul analysis: a variable is substituted only when every assignment gives it ONE static value
 *  (no $(…)/backticks — those are runtime values; a re-assigned name stays a literal $NAME). */
function expandVarsStatic(command: string): string {
  const vars: Record<string, string> = { HOME: os.homedir(), WISDOM_OS_ROOT: WOS_ROOT };
  const bad = new Set<string>();
  const sub = (x: string) => x.replace(/\$\{(\w+)\}|\$(\w+)/g, (m0, a, b) => (bad.has(a || b) ? undefined : vars[a || b]) ?? m0);
  const assign = /(?:^|[;&|\n]\s*|\s)(?:export\s+|local\s+)?([A-Za-z_]\w*)=("([^"]*)"|'([^']*)'|([^\s;&|]*))/g;
  let m: RegExpExecArray | null;
  while ((m = assign.exec(command)) !== null) {
    const raw = m[3] ?? m[4] ?? m[5] ?? "";
    if (/\$\(|`|\$\{?[A-Za-z_]\w*\}?\[|^\(/.test(raw) || (m[1] in vars && !["HOME", "WISDOM_OS_ROOT"].includes(m[1]) && vars[m[1]] !== (m[4] !== undefined ? raw : sub(raw)))) { bad.add(m[1]); continue; }
    vars[m[1]] = m[4] !== undefined ? raw : sub(raw);
  }
  return sub(command);
}

/** Does bash `command` (run in cwd0) do anything to 01_Soul other than READ it? (refuse ⇔ true) */
export function bashTouchesSoul(command: string, cwd0: string, depth = 0): boolean {
  if (depth > 12) return true;    // fail closed past 12 nested substitutions / -c strings
  const flat0 = command.replace(/["'\\]/g, "");
  const nearSoul = (w: string, c: string) => {   // inside Soul, or an ancestor no higher than the vault
    const r = soulRel(w, c);
    if (r !== "anc") return r === "in";
    const abs = resolved(w, c);
    return SOUL_ROOTS.some((root) => under(abs, path.dirname(path.dirname(root))));
  };
  // fast path: nothing to parse unless the text can reach Soul
  if (!flat0.includes("01_Soul") && soulRel(cwd0, "/") === null && !/[*?[]/.test(command) && !/\bcd\b|\bpushd\b/.test(flat0) &&
      !/\$\(|`|<\(|>|\b(?:rm|mv|chmod|chown|chgrp|rsync|cp|find|tar|unzip|xargs|grep|rg|for|while|eval|sed|perl|awk|gawk|tee|truncate|dd|install|ln|touch|mkdir|rmdir|unlink|shred|python\d*|node|ruby|php|bun|deno|curl|wget|rename|git|sort|vim?|nano|ed)\b/.test(flat0)) return false;
  const expanded = expandVarsStatic(command);
  const hd = splitHeredocs(expanded);
  // heredoc bodies: shells recurse; interpreters are judged by their writes; unquoted bodies still run $(…)
  const headCmd = (h: string) => {
    const seg = segments(h.replace(/<<-?\s*(['"]?)[A-Za-z_][\w.-]*\1.*$/, "")).pop() ?? [];
    let w = seg; while (w.length && PREFIX_RX.test(w[0])) w = w.slice(1);
    return path.basename(w[0] ?? "");
  };
  for (const b of hd.bodies) {
    const x = headCmd(b.head);
    if (SHELLS.has(x)) { if (bashTouchesSoul(b.body, cwd0, depth + 1)) return true; continue; }
    if (INTERP_RX.test(x)) { if (interpWritesSoul(b.body, langOf(x), [cwd0], depth)) return true; continue; }
    if (!b.quoted) for (const u of extractSubst(b.body).units) if (bashTouchesSoul(u, cwd0, depth + 1)) return true;
  }
  // substitutions: analyse every body recursively, then stand in for its OUTPUT (a Soul path if it can yield one)
  const ex = extractSubst(hd.shell);
  const unitYieldsSoul: boolean[] = [];
  for (const u of ex.units) {
    if (bashTouchesSoul(u, cwd0, depth + 1)) return true;
    const fl = u.replace(/["'\\]/g, "");
    const lister = segments(u).some((ws) => {
      const c = path.basename(ws[0] ?? "");
      const ops = ws.slice(1).filter((w) => !w.startsWith("-"));
      return ops.some((w) => nearSoul(w, cwd0)) || (["find", "ls", "rg", "fd", "git"].includes(c) && !ops.length && nearSoul(".", cwd0));
    });
    unitYieldsSoul.push(fl.includes("01_Soul") || lister);
  }
  const shell = markSubshells(ex.shell.replace(/\u0002(\d+)\u0002/g, (_m, n) => unitYieldsSoul[+n] ? `'${SOUL_P()}'` : "__SUBST__"));

  let cwd = cwd0;
  const cwds = new Set<string>([cwd0]);
  const cwdStack: string[] = [];
  let feedsSoul = false;    // an earlier lister enumerated a tree containing Soul (feeds xargs / while read)
  const segs = segments(shell);
  // for VAR in LIST with a Soul item binds $VAR; `lister SOUL | while read VAR` binds $VAR
  const bound = new Map<string, string>();
  for (const fm of shell.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;\n]+?)\s*(?:;|\n)\s*do\b/g)) {
    const hit = segments(fm[2]).flat().find((w) => soulRel(w, cwd0) === "in");
    if (hit) bound.set(fm[1], hit);
  }
  const whileVar = /\bwhile\s+(?:IFS=\S*\s+)?read\s+(?:-\w+\s+)*([A-Za-z_]\w*)/.exec(shell)?.[1];
  const subst = (w: string) => w.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m0, v) => bound.get(v) ?? m0);
  const recursive = (args: string[]) => args.some((w) => /^-[^-]*[rRa]/.test(w) || w === "--recursive" || w === "--archive");
  for (const words0 of segs) {
    if (words0[0] === "__PUSH__") { cwdStack.push(cwd); continue; }          // ( … ) subshell: cd does not leak out
    if (words0[0] === "__POP__") { if (cwdStack.length) cwd = cwdStack.pop()!; continue; }
    let words = words0.map(subst);
    while (words.length && PREFIX_RX.test(words[0])) {
      if (words[0] === "timeout" || words[0] === "flock") {
        let k = 1; while (k < words.length && words[k].startsWith("-")) k += (/^-(?:k|s|w|E)$/.test(words[k]) ? 2 : 1);
        words = words.slice(k + 1);
      } else words = words.slice(1);
    }
    if (!words.length) continue;
    // shell grammar words are not commands: `for f in LIST` / `case` / `done` / `[[ … ]]` only name strings
    if (/^(?:for|select|case|esac|done|fi|in|function|\}|\[\[|\]\]|\(\(|\)\)|;;|return|exit|break|continue|local|declare|readonly|set|shift|wait|trap|unset|export|read|mapfile)$/.test(words[0])) continue;
    const cmd = path.basename(words[0]);
    // the value side of option/assignment words (--output=X, of=X, -oX is not split)
    const valueOf = (w: string) => /^[^=]*=/.test(w) && !/^['"]/.test(w) ? w.slice(w.indexOf("=") + 1) : w;
    const IN = (w: string) => soulRel(valueOf(w), cwd) === "in";
    const INV = (w: string) => IN(w) || (feedsSoul && whileVar !== undefined && new RegExp("\\$\\{?" + whileVar + "\\b").test(w));
    // redirects: ANY command writing into Soul (2>&1 / >&- are fd dups)
    for (let i = 0; i < words.length; i++) {
      if (/^\d*>&$/.test(words[i]) && /^(?:\d+|-)$/.test(words[i + 1] ?? "")) { i++; continue; }
      if (/^\d*>{1,2}[&|]?$|^&>>?$|^\d*<>$/.test(words[i]) && words[i + 1] && INV(words[i + 1])) return true;
    }
    if (/^\d*[<>]/.test(words[0]) || /^&>/.test(words[0])) continue;   // a redirect-only segment (after `( … )`): checked above
    if (cmd === "cd" || cmd === "pushd") { if (words[1]) { cwd = resolved(words[1], cwd); cwds.add(cwd); } continue; }
    const args = words.slice(1).filter((w, i, a) => !/^\d*[<>]/.test(w) && !/^\d*[<>]/.test(a[i - 1] ?? "") && !/^&>/.test(w));
    const operands = args.filter((w) => !w.startsWith("-"));
    const cwdInSoul = soulRel(cwd, "/") === "in";
    // a Soul cwd touches through RELATIVE operands, or when an unknown command gets no operand at all (make, git pull)
    const touches = args.some(INV) || (cwdInSoul && (operands.length === 0 || operands.some((w) => !path.isAbsolute(w) && !w.startsWith("~"))));
    // ---- ANCESTOR rules: they never name Soul, so the allowlist alone would not see them ----
    if (["rm", "chmod", "chown", "chgrp", "setfacl"].includes(cmd) && recursive(args) && operands.some((w) => soulRel(w, cwd) === "anc")) return true;
    if (cmd === "mv") {
      const tIdx = args.findIndex((w) => w === "-t" || w === "--target-directory");
      const srcs = tIdx >= 0 ? operands.filter((w) => w !== args[tIdx + 1]) : operands.slice(0, -1);
      if (srcs.some((w) => soulRel(w, cwd) === "anc")) return true;
    }
    if (["cp", "rsync", "install"].includes(cmd)) {
      const tIdx = args.findIndex((w) => w === "-t" || w === "--target-directory");
      const dest = tIdx >= 0 ? args[tIdx + 1] : operands[operands.length - 1];
      const srcs = tIdx >= 0 ? operands.filter((w) => w !== dest) : operands.slice(0, -1);
      if (dest && soulRel(dest, cwd) === "anc" && (operands.length >= 2 || tIdx >= 0)) {
        if (srcs.some((w) => w.replace(/\/+\.?$/, "").endsWith("01_Soul"))) return true;
        if (cmd === "rsync" && args.some((w) => w.startsWith("--delete"))) return true;
        if (recursive(args)) {
          const rel = SOUL_ROOTS.map((r) => path.relative(resolved(dest, cwd), r)).find((r) => r && !r.startsWith(".."));
          for (const w of srcs) {
            if (!rel) break;
            const src = resolved(w, cwd);
            const contents = /\/\.?$/.test(w);
            const probe = contents ? path.join(src, rel) : (rel.split(path.sep)[0] === path.basename(src) ? path.join(path.dirname(src), rel) : "");
            try { if (probe && fs.existsSync(probe)) return true; } catch { /* unreadable source */ }
          }
        }
      }
    }
    if ((cmd === "tar" || cmd === "bsdtar") && (args.some((w) => /^-[^-]*x/.test(w) || w === "--extract" || w === "--get") || /^[a-wyz]*x/.test(args[0] ?? ""))) {
      const cIdx = args.findIndex((w) => w === "-C" || w === "--directory");
      const dir = cIdx >= 0 ? args[cIdx + 1] : (args.find((w) => w.startsWith("--directory="))?.slice(12) ?? cwd);
      if (nearSoul(dir, cwd)) return true;
    }
    if (cmd === "unzip") { const d = args.findIndex((w) => w === "-d"); if (nearSoul(d >= 0 ? args[d + 1] : cwd, cwd)) return true; }
    // listers feed later xargs / while read
    if (["find", "grep", "egrep", "fgrep", "rg", "fd", "ls", "git"].includes(cmd)) {
      const paths = ["grep", "egrep", "fgrep", "rg"].includes(cmd) ? operands.slice(1) : operands;
      const rec = cmd === "find" || cmd === "rg" || cmd === "fd" || cmd === "git" || recursive(args) || args.some((w) => /^-[^-]*l/.test(w));
      if (paths.some((w) => soulRel(w, cwd) !== null) || (rec && !paths.length && soulRel(cwd, "/") !== null)) feedsSoul = true;
    }
    if (cmd === "find") {
      const starts: string[] = [];
      for (const w of args) { if (w.startsWith("-") || w === "!" || w === "(") break; starts.push(w); }
      if ((starts.length ? starts : ["."]).some((w) => soulRel(w, cwd) !== null)) {
        if (args.includes("-delete")) return true;
        if (args.some((w, i) => /^-f(?:print0?|printf|ls)$/.test(w) && args[i + 1] && IN(args[i + 1]))) return true;
        for (let i = 0; i < args.length; i++) {
          if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i])) continue;
          const sub: string[] = [];
          for (let j = i + 1; j < args.length && args[j] !== ";" && args[j] !== "+"; j++) sub.push(args[j]);
          if (payloadWritesSoul(sub, cwd, depth)) return true;
        }
      }
      continue;   // find itself only reads
    }
    if (cmd === "xargs") {
      let k = 1;
      while (k < words.length && words[k].startsWith("-")) k += /^-(?:[daEeIiLlnPs]|-(?:delimiter|arg-file|eof|max-lines|max-args|max-procs|max-chars|replace))$/.test(words[k]) ? 2 : 1;
      const payload = words.slice(k);
      if (feedsSoul || payload.some(IN) || cwdInSoul) { if (payloadWritesSoul(payload.length ? payload : ["echo"], cwd, depth)) return true; }
      continue;
    }
    // ---- recursion into command strings ----
    // soul_sandbox.sh <ro-dir> <b64> [mode]: binds the Soul path READ-ONLY and runs the command inside → a reader
    if (isSoulReaderTool(words[0], cwd) || (SHELLS.has(cmd) && operands[0] && isSoulReaderTool(operands[0], cwd) &&
        !args.some((w) => /^-\w*c\w*$/.test(w)))) continue;
    if (SHELLS.has(cmd)) {
      const ci = args.findIndex((w) => /^-\w*c\w*$/.test(w));
      if (ci >= 0 && args[ci + 1] !== undefined) { if (bashTouchesSoul(args[ci + 1], cwd, depth + 1)) return true; continue; }
      if (touches) return true;          // `bash script.sh <soul>` / in a Soul cwd: cannot see into the script
      continue;
    }
    if (cmd === "eval") {
      const s = args.join(" ");
      if (s.replace(/["'\\]/g, "").includes("01_Soul") || cwdInSoul || bashTouchesSoul(s, cwd, depth + 1)) return true;
      continue;
    }
    // ---- interpreters: judged by their write-mode calls (inline code); argv Soul paths need write-free code ----
    if (INTERP_RX.test(cmd)) {
      const lang = langOf(cmd);
      const ci = args.findIndex((w) => /^-(?:c|e|E|r)$/.test(w));
      const code = ci >= 0 ? args[ci + 1] ?? "" : "";
      const hereBody = hd.bodies.find((b) => b.head.includes(words0.join(" ").slice(0, 20)) || headCmd(b.head) === cmd)?.body ?? "";
      const inline = code || hereBody;
      if (inline && interpWritesSoul(inline, lang, [...cwds], depth)) return true;
      const argv = args.filter((w, i) => !(ci >= 0 && i === ci + 1));
      // perl/ruby -i (in-place, bundled as -pi / -i.bak / -pie) on a Soul operand is the sed -i shape
      if ((lang === "pl") && argv.some((w) => /^-[^-]*i/.test(w)) && (argv.some(IN) || cwdInSoul)) return true;
      // `python3 - ARGS <<EOF` / `-c CODE ARGS`: argv after "-" are script ARGS, not a script file
      const firstOp = argv.findIndex((w) => !w.startsWith("-"));
      const dash = argv.indexOf("-");
      const scriptFile = ci < 0 && firstOp >= 0 && (dash < 0 || firstOp < dash) ? argv[firstOp] : undefined;
      // a Soul path handed over in argv; OR in the environment (VAR=<soul> prefix / export in this command) — env
      // counts only for INLINE code we can read (os.environ use is visible); a script file run with a Soul path in env
      // only is NOT refused (OM tests pass OM_SOUL_DIR to read Soul: 8 such calls in the 7-day replay)
      const asg = (w: string) => /^[A-Za-z_]\w*=/.test(w) && soulRel(w.slice(w.indexOf("=") + 1), cwd) === "in";
      const envSoul = words0.slice(0, Math.max(0, words0.indexOf(words[0]))).some(asg) ||
        segs.some((sg) => sg[0] === "export" && sg.slice(1).some(asg));
      const soulArgv = argv.some(IN) || (envSoul && !!inline);
      if (scriptFile) {
        // the one exact sanctioned form: /usr/bin/python3 ~/.wos-runtime/wisdom_guard.py check|write … — alone
        if (soulArgv && isSanctionedWisdomGuard(words0, segs.length, shell)) continue;
        if (isSoulReaderTool(scriptFile, cwd)) continue;   // fleet/soul_propose.py: reads Soul to check the anchor
        if (soulArgv || cwdInSoul) return true;     // a script we cannot see is handed Soul (or runs inside it)
        continue;
      }
      if (soulArgv && (!inline || interpWritesSoul(inline, lang, [...cwds], depth, true))) return true;   // argv/env Soul → targets from argv/env/unknown
      continue;
    }
    if (cmd === "wisdom_guard.py" || path.resolve(cwd, words[0]) === WISDOM_GUARD) {
      if (touches && !isSanctionedWisdomGuard(words0, segs.length, shell)) return true;
      continue;
    }
    if (cmd === "sed") {   // a w/W command or s///w flag writes its FILE argument, wherever the input lives
      const eIdx = args.flatMap((w, i) => (w === "-e" || w === "--expression") ? [i + 1] : []);
      const scripts = eIdx.length ? eIdx.map((i) => args[i] ?? "") : [operands[0] ?? ""];
      for (const sc of scripts) for (const wm of sc.matchAll(/(?:^|[;{}\n]|\/[gIipmM0-9]*)\s*[wW]\s+([^;\n}]+)/g)) if (IN(wm[1].trim())) return true;
    }
    if (cmd === "ln" && touches) {
      // `ln -s <soul> <dest outside Soul>` = a read-only handle on Soul; refuse a link created INSIDE Soul, or a
      // hard link (same inode: writing it writes Soul)
      const sym = args.some((w) => /^-[^-]*s/.test(w) || w === "--symbolic");
      const tIdx = args.findIndex((w) => w === "-t" || w === "--target-directory");
      const dest = tIdx >= 0 ? args[tIdx + 1] : (operands.length >= 2 ? operands[operands.length - 1] : ".");
      if (sym && dest && soulRel(dest, cwd) !== "in") continue;
      return true;
    }
    if (!touches) continue;
    // ---- READER ALLOWLIST: this simple command touches Soul ----
    if (PURE_READERS.has(cmd)) continue;
    if (cmd === "sed") {
      if (args.some((w) => /^-[^-]*i/.test(w) || w.startsWith("--in-place") || w === "-f" || w.startsWith("--file"))) return true;
      const eIdx = args.flatMap((w, i) => (w === "-e" || w === "--expression") ? [i + 1] : []);
      const scripts = eIdx.length ? eIdx.map((i) => args[i] ?? "") : [operands[0] ?? ""];
      if (scripts.some((s) => /(?:^|[;{}\n\s])[wWe](?:\s|$)|\/[gIipmM0-9]*[we](?:\s|$|;)/.test(s))) return true;
      continue;
    }
    if (cmd === "awk" || cmd === "gawk" || cmd === "mawk") {
      if (args.some((w, i) => (w === "-i" && args[i + 1] === "inplace") || w === "-iinplace" || w.startsWith("--include") || w === "-f")) return true;
      const prog = operands[0] ?? "";
      // output redirection / pipes / system(): `print … > "f"`, `printf … >> f`, `print | "cmd"`, `"cmd" | getline`
      if (/\b(?:print|printf)\b[^;{}]*?(?:>|\|)|\|\s*getline|system\s*\(|\bclose\s*\(|fflush\s*\(/.test(prog)) return true;
      continue;
    }
    if (cmd === "sort") { if (args.some((w) => w === "-o" || /^-[^-]*o/.test(w) || w.startsWith("--output"))) return true; continue; }
    if (cmd === "uniq") { if (operands.length > 1) return true; continue; }
    if (cmd === "git") {
      let k = 0;
      while (k < args.length && args[k].startsWith("-")) k += /^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(args[k]) ? 2 : 1;
      const sub = args[k] ?? "";
      if (GIT_READ.has(sub) && !args.some((w) => /^--output/.test(w) || w === "-o")) continue;
      return true;
    }
    if (cmd === "cp" || cmd === "rsync") {
      const tIdx = args.findIndex((w) => w === "-t" || w === "--target-directory");
      const dest = tIdx >= 0 ? args[tIdx + 1] : operands[operands.length - 1];
      if (cmd === "rsync" && args.some((w) => w.startsWith("--remove-source") || w.startsWith("--delete"))) return true;
      if (!dest || (operands.length < 2 && tIdx < 0) || nearSoul(dest, cwd) || cwdInSoul && !path.isAbsolute(dest)) return true;
      continue;
    }
    if (cmd === "tar" || cmd === "bsdtar") {
      const create = args.some((w) => /^-[^-]*[ct]/.test(w) || w === "--create" || w === "--list") || /^[a-wyz]*[ct]/.test(args[0] ?? "");
      const fIdx = args.findIndex((w) => /^-[^-]*f$/.test(w) || w === "--file" || /^[a-z]*f$/.test(w) && w === args[0]);
      const archive = fIdx >= 0 ? args[fIdx + 1] : args.find((w) => w.startsWith("--file="))?.slice(7);
      if (!create || args.some((w) => w === "--remove-files") || (archive && archive !== "-" && IN(archive))) return true;
      continue;
    }
    return true;   // anything else that touches Soul: unknown ⇒ refused (curl -o, wget -O, rename, dd, truncate, touch, ln …)
  }
  return false;
}

/** `[/usr/bin/python3] ~/.wos-runtime/wisdom_guard.py <check|write> …` exactly: one simple command, no wrapper, no
 *  redirect, no pipe, no separator, no newline, no substitution. Flags parsed by name. (S0 in wisdom_guard.py refuses
 *  every Soul write anyway — this only keeps the read-only `check` and the honest refusal path reachable.) */
function isSanctionedWisdomGuard(words: string[], nSegs: number, shell: string): boolean {
  if (nSegs !== 1 || /[|;&\n<>`]|\$\(|__SUBST__/.test(shell.trim())) return false;
  let i = 0;
  if (words[0] === "/usr/bin/python3") i = 1;
  else if (words[0] !== WISDOM_GUARD && words[0] !== "~/.wos-runtime/wisdom_guard.py") return false;
  const script = words[i] === "~/.wos-runtime/wisdom_guard.py" ? WISDOM_GUARD : words[i];
  if (script !== WISDOM_GUARD || realOrSelf(script) !== realOrSelf(WISDOM_GUARD)) return false;
  if (words.slice(i + 1).some((w) => w.startsWith("-"))) return false;   // the CLI takes no flags
  const sub = words[i + 1];
  if (sub !== "check" && sub !== "write") return false;
  if (sub === "write" && (words[i + 3] ?? "") === "human") return false;
  return true;
}

// Control Tower panel-socket bash block removed 2026-10-03 (request 2026-10-03, single-user model):
// the panel server's own mount-namespace peer check still refuses directive POSTs from jailed agent bash.

function refuseSoul(toolName: string, target: string) {
  const reason = `Refused: ${toolName} would write inside 01_Soul. ${SOUL_ROUTE} Nothing was run.`;
  recordAndReport(toolName, target, reason, SOUL_GATE);
  return { block: true, reason };
}

function recordAndReport(toolName: string, target: string, reason: string, gate = "background-canonical-soul-write"): void {
  const env = envelope();
  const requestId = String(env?.request_id ?? "");
  const prior = priorBlocks();
  // Dedupe only per real request id: with no envelope (request_id "") every block is its own event and is logged.
  if (requestId && prior.some((row) => row.request_id === requestId && row.target === target &&
      row.outcome === "blocked" && (row.gate ?? "background-canonical-soul-write") === gate)) return;
  const alreadyNotified = Boolean(requestId && prior.some((row) =>
    row.request_id === requestId && row.outcome === "blocked" && (row.gate ?? "background-canonical-soul-write") === gate));

  const event = {
    ts: new Date().toISOString(),
    gate,
    outcome: "blocked",
    request_id: requestId,
    agent: AGENT,
    tool: toolName,
    target,
    reason,
    brief: process.env.WOS_AGENT_BRIEF || "",
  };
  fs.mkdirSync(path.dirname(BLOCK_LOG), { recursive: true });
  fs.appendFileSync(BLOCK_LOG, JSON.stringify(event) + "\n", "utf8");

  if (!env || !requestId || alreadyNotified || !fs.existsSync(INBOX_WRITER)) return;
  const report = {
    ...env,
    session: AGENT,
    status: "blocked",
    summary: gate === AGENTS_GATE
      ? `PROTECTED WRITE BLOCKED before execution: ${AGENT} attempted to write AGENTS.md directly. Stage a candidate; DIR-wos installs it with ${AGENTS_INSTALLER}.`
      : `PROTECTED WRITE BLOCKED before execution: ${AGENT} attempted to mutate canonical Soul. Work must continue in an isolated candidate and be promoted only after independent verification.`,
    artifact: BLOCK_LOG,
    next: gate === AGENTS_GATE
      ? "Continue with the candidate; request install through DIR-wos (agents_md_install.py apply)."
      : "Main Pi consumes the blocker; preserve the candidate, correct the brief/workspace, and redispatch under the read-only sandbox.",
    guard: gate,
    blocked_target: target,
    evidence: [{ command: `wos-protected-write:${toolName}`, exit_code: 126 }],
  };
  // inbox_schema's CLI defaults --status to "done" and applies CLI values after --json, so pass
  // the blocker status explicitly; otherwise the early-warning row would masquerade as completion.
  const args = [INBOX_WRITER, "append", "--status", "blocked", "--json", JSON.stringify(report)];
  if (INBOX_PATH) args.push("--path", INBOX_PATH);
  // an earlier request r2: local $HOME cwd (Bun chdir()s into the cwd inside vfork() while Pi is frozen; the
  // default cwd is the wisdom-os mount). inbox_schema.py append: absolute writer + absolute/expanduser --path; its only
  // cwd-relative syscall is bash's PWD init inside its `date` helper (evidence r2/cwd_probe_results.txt). A relative
  // WOS_PROTECTED_WRITE_INBOX (test seam) keeps the old cwd so its meaning never changes.
  const cwdOk = !INBOX_PATH || path.isAbsolute(INBOX_PATH);
  const result = spawnSync("/usr/bin/python3", args, { encoding: "utf8", timeout: 5000, ...(cwdOk ? { cwd: os.homedir() } : {}) });
  if (result.status !== 0) {
    fs.appendFileSync(BLOCK_LOG, JSON.stringify({
      ts: new Date().toISOString(), gate: event.gate, outcome: "notification-failed",
      request_id: requestId, agent: AGENT, detail: String(result.stderr || result.stdout).slice(-800),
    }) + "\n", "utf8");
  }
}

function refuse(toolName: string, target: string) {
  const reason = `Background agents cannot write canonical Soul: ${target}. ${SOUL_ROUTE}`;
  recordAndReport(toolName, target, reason);
  return { block: true, reason, terminate: true };
}

// 🔴 request 2026-09-23 — a STALE ctx must fail CLOSED, explicitly.
// After a session replacement or /reload, Pi invalidates the old extension runner and every ctx
// getter (`mode`, `cwd`, …) throws "extension ctx is stale …". On 2026-09-23 DIR-wos's pane printed
// exactly that from line 149 (`ctx?.mode` in tool_result) after `pi --session` resume. Measured in
// the Pi 0.86 host: a throw in a `tool_call` handler propagates (emitToolCall has no catch) and
// prepareToolCall turns it into an error result, so the tool did NOT run — fail-closed, but only by
// the host's accident. A throw in `tool_result` is caught and swallowed by emitToolResult, so the
// EROFS early-warning report was LOST (fail-open for the report; the read-only mount still held).
// So the guard no longer depends on the host: an unreadable ctx is treated as "guard applies".
function isStaleError(error: unknown): boolean {
  return /stale/i.test(String((error as any)?.message ?? error));
}

function ctxRead<T>(read: () => T): { value?: T; stale: boolean; error?: unknown } {
  try {
    return { value: read(), stale: false };
  } catch (error) {
    return { stale: isStaleError(error), error };
  }
}

/** Is this a guarded (background / print) runtime? An unreadable ctx answers YES (fail closed). */
function guarded(ctx: any): { on: boolean; stale: boolean } {
  if (IS_BACKGROUND) return { on: true, stale: false };
  const mode = ctxRead(() => ctx?.mode);
  if (mode.error !== undefined) return { on: true, stale: mode.stale };
  return { on: mode.value === "print", stale: false };
}

function cwdOf(ctx: any): string {
  const cwd = ctxRead(() => ctx?.cwd);
  return String((cwd.error === undefined && cwd.value) || process.cwd());
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    // AGENTS.md is installer-only in EVERY mode (foreground included) — checked before the mode gate.
    {
      const cwd = cwdOf(ctx);
      if (event?.toolName === "write" || event?.toolName === "edit") {
        const target = resolved(event?.input?.path, cwd);
        if (isAgentsMd(target)) return refuseAgentsMd(event.toolName, target);
      } else if (event?.toolName === "bash") {
        if (bashTouchesAgentsMd(String(event?.input?.command ?? ""), cwd)) return refuseAgentsMd("bash", AGENTS_MD);
      }
      // 01_Soul is L3 in EVERY mode too (request 2026-10-03). Background/print agents keep the
      // terminating refusal below; every other mode (foreground Directors, the owner's own session) is refused here.
      let soulTarget: string | null = null;
      if (event?.toolName === "write" || event?.toolName === "edit") soulTarget = toolTargetInSoul(event?.input?.path, cwd);
      else if (event?.toolName === "bash" && bashTouchesSoul(String(event?.input?.command ?? ""), cwd)) soulTarget = SOUL_ROOT;
      if (soulTarget !== null) {
        const g0 = guarded(ctx);
        if (g0.on && !g0.stale) return refuse(event.toolName, soulTarget);
        return refuseSoul(event.toolName, soulTarget);
      }
    }
    // `print` mode is Pi's one-shot/background shape. This catches Pi launchers that have not yet
    // migrated to wos_bg; WOS_BACKGROUND_AGENT carries the stronger routing/report envelope.
    const g = guarded(ctx);
    if (!g.on) return;
    if (g.stale) {
      // A tool call on a torn-down runner belongs to a replaced session: never run it.
      return {
        block: true,
        reason: "Refused: this tool call arrived on a stale extension context (session replaced or reloaded); " +
          "the protected-write guard cannot establish its mode, so nothing runs. Re-issue it from the live session.",
      };
    }
    const cwd = cwdOf(ctx);

    if (event?.toolName === "write" || event?.toolName === "edit") {
      const target = resolved(event?.input?.path, cwd);
      if (under(target, SOUL_ROOT)) return refuse(event.toolName, target);
      return;
    }

    if (event?.toolName === "bash") {
      const command = String(event?.input?.command ?? "");
      if (bashLooksMutating(command)) return refuse("bash", SOUL_ROOT);
    }
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!guarded(ctx).on || event?.toolName !== "bash") return;
    const command = String(event?.input?.command ?? "");
    const content = JSON.stringify(event?.content ?? "");
    if (commandMentionsSoul(command) && /Read-only file system|EROFS/i.test(content)) {
      recordAndReport("bash:os-sandbox", SOUL_ROOT,
        "The OS read-only mount blocked an indirect canonical Soul write.");
      return { isError: true };
    }
  });
}
