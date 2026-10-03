// wos-destructive-guard.ts — refuse destructive commands aimed at a protected root (or its ancestor).
// @pi-child-safe: one bash tool_call refusal hook only; contributes no prompt, context, tools, or startup writes.
// Incident request 2026-10-03: /srv/users/<u>/sync-home was the same inode as $HOME.
// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Word = { text: string; dynamic: boolean; expandVars: boolean; expandTilde: boolean };
type Invocation = { argv: Word[]; vars: Record<string, string> };
export type RootEvidence = { name: string; lexical: string; real: string; devino: string | null };
export type GuardVerdict = { refuse: boolean; operation?: string; target?: string; root?: string; evidence?: string; reason?: string };

/* Shell word splitting adapted (not imported, so this child-safe extension stands alone) from
 * ~/.pi/agent/extensions/wos-guards.ts shellCommands(), source sha256
 * b7bf7eeb5c9d480c580dc8c233557fbc2d672e90be01f4df334bf9282a31dbf9.
 * It removes quotes, honors command separators, and marks substitutions/globs dynamic. It never executes shell text. */
export function shellInvocations(src: string): Invocation[] | null {
  const out: Invocation[] = [];
  let words: Word[] = [], text = "", active = false, dynamic = false, expandVars = false, expandTilde = false, quote = "", esc = false;
  const vars: Record<string, string> = {};
  const word = () => { if (active) words.push({ text, dynamic, expandVars, expandTilde }); text = ""; active = dynamic = expandVars = expandTilde = false; };
  const command = () => {
    word();
    while (words.length && ["!", "then", "do", "else", "elif", "if", "while", "until"].includes(words[0].text)) words.shift();
    const local = { ...vars };
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text) && !words[0].dynamic) {
      const w = words.shift()!.text, k = w.indexOf("="); local[w.slice(0, k)] = w.slice(k + 1);
    }
    if (words.length) out.push({ argv: words, vars: local });
    else Object.assign(vars, local); // standalone X=value persists for later simple commands
    words = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (esc) { text += c; active = true; esc = false; continue; }
    if (c === "\\" && quote !== "'") { esc = true; active = true; continue; }
    if (quote) {
      if (c === quote) { quote = ""; active = true; continue; }
      if (quote === '"' && c === "$") { dynamic = true; expandVars = true; }
      if (quote === '"' && c === "`") dynamic = true;
      text += c; active = true; continue;
    }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (c === "#" && !active) { while (i < src.length && src[i] !== "\n") i++; command(); continue; }
    if (/\s/.test(c)) { if (c === "\n") command(); else word(); continue; }
    if (";&|()".includes(c)) { command(); if ((c === ";" || c === "&" || c === "|") && src[i + 1] === c) i++; continue; }
    if (c === "$" || c === "`" || c === "*" || c === "?" || c === "[") dynamic = true;
    if (c === "$") expandVars = true;
    if (c === "~" && !active) expandTilde = true;
    text += c; active = true;
  }
  if (quote || esc) return null;
  command();
  return out;
}

function mountsUnderGdrive(home: string): string[] {
  const gd = path.join(home, "wisdom-os"), found = new Set<string>([gd]);
  try {
    for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      const f = line.split(" ");
      if (f.length < 5) continue;
      const m = f[4].replace(/\\([0-7]{3})/g, (_x, o) => String.fromCharCode(parseInt(o, 8)));
      if (m === gd || m.startsWith(gd + path.sep)) found.add(m);
    }
  } catch { /* literal wisdom-os remains protected */ }
  return [...found];
}

function canonicalExisting(p: string): string {
  let cur = path.resolve(p), suffix: string[] = [];
  while (true) {
    try { return path.join(fs.realpathSync(cur), ...suffix); }
    catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      suffix.unshift(path.basename(cur)); cur = parent;
    }
  }
}

function devino(p: string): string | null {
  try { const s = fs.statSync(p, { bigint: true }); return `${s.dev}:${s.ino}`; } catch { return null; }
}

export function protectedRoots(home = os.homedir()): RootEvidence[] {
  const u = path.basename(home);
  const raw = ["/", "/home", "/data", "/srv/users", `/srv/users/${u}`, `/srv/users/${u}/sync-home`, home,
    ...mountsUnderGdrive(home), path.join(home, ".wos-runtime"), path.join(home, ".pi"), path.join(home, ".claude"),
    path.join(home, ".local"), ...["bin", "share", "lib", "libexec", "state"].map(x => path.join(home, ".local", x)),
    path.join(home, ".config"), path.join(home, ".cache"), path.join(home, ".ssh")];
  return [...new Set(raw.map(p => path.resolve(p)))].map(lexical => {
    const real = canonicalExisting(lexical); return { name: lexical, lexical, real, devino: devino(real) };
  });
}

type Expanded = { value: string | null; staticPrefix: string | null };
function expandWord(w: Word, vars: Record<string, string>, home: string): Expanded {
  let s = w.text;
  if (w.expandTilde) s = s.replace(/^~(?=\/|$)/, home);
  if (w.expandVars) s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, a, b) => { const k = a || b; return vars[k] ?? (k === "HOME" ? home : `\$${k}`); });
  const bad = w.dynamic ? s.search(/[`*?\[]|\$\(|\$\{[^}]*[:-]|\$[A-Za-z_{]/) : -1;
  if (bad < 0) return { value: s, staticPrefix: null };
  let prefix = s.slice(0, bad);
  if (!prefix) return { value: null, staticPrefix: null };
  // Keep a fixed filename prefix: ~/.cache/file* can only name descendants and must stay allowed.
  // A prefix ending in slash names the directory itself as the uncertainty boundary (/home/* => /home => refuse).
  return { value: null, staticPrefix: prefix || "/" };
}

function optionTargets(argv: string[], op: string): string[] {
  const args: string[] = []; let after = false;
  const takesValue = new Set(["--exclude", "--include", "--filter", "--backup-dir", "--temp-dir", "--files-from", "--exclude-from", "--include-from", "--reference", "--from"]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!after && a === "--") { after = true; continue; }
    if (!after && a.startsWith("-")) {
      const key = a.split("=")[0]; if (takesValue.has(key) && !a.includes("=")) i++;
      continue;
    }
    args.push(a);
  }
  if (op === "find -delete") {
    const starts: string[] = [];
    for (const a of args) { if (a.startsWith("-") || a === "(" || a === "!") break; starts.push(a); }
    return starts.length ? starts : ["."];
  }
  if (op === "mv" || op === "rsync --delete") return args; // source deletion/move and destination deletion both matter
  return args;
}

function operation(argv: string[]): string | null {
  const prog = path.basename(argv[0] || "");
  const flags = argv.slice(1).filter(x => x.startsWith("-") && x !== "--").join("");
  if (prog === "rm" && (/(^|-)r|R/.test(flags) || /(^|-)f/.test(flags) || argv.includes("--recursive") || argv.includes("--force"))) return "rm recursive/forced";
  if (prog === "find" && argv.includes("-delete")) return "find -delete";
  if (prog === "rsync" && argv.some(x => x === "--delete" || x.startsWith("--delete-"))) return "rsync --delete";
  if (prog === "mv") return "mv";
  if ((prog === "chmod" || prog === "chown") && (/[R]/.test(flags) || argv.includes("--recursive"))) return `${prog} recursive`;
  return null;
}

function isAncestorOrSame(target: string, root: string): boolean {
  return target === root || root.startsWith(target === "/" ? "/" : target + path.sep);
}

function nestedUnparsed(body: string): GuardVerdict | null {
  if (/\b(rm|find|rsync|mv|chmod|chown)\b/.test(body) && /(?:^|\s)["']?(?:\/|~\/|\$\{?[A-Za-z_])/.test(body))
    return { refuse: true, operation: "unparsed nested destructive command", target: body.slice(0, 160), root: "unknown protected root",
      evidence: "nested command could not be parsed safely",
      reason: "REFUSED unparseable nested destructive command with an absolute/variable target. Safer alternative: issue one literal command against an owner-only /tmp child path." };
  return null;
}

function withoutHeredocBodies(src: string): string {
  const lines=src.split("\n"), out:string[]=[]; let delim="", strip=false;
  for(const line of lines){
    if(delim){const t=strip?line.replace(/^\t+/,""):line;if(t===delim){delim="";strip=false;} continue;}
    out.push(line); const m=line.match(/<<(-)?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/); if(m){strip=!!m[1];delim=m[2];}
  }
  return out.join("\n");
}

/** Pure decision over parsed command + supplied path evidence. The hook supplies realpath/stat evidence; tests can supply fixtures. */
export function classifyCommand(command: string, cwd: string, roots: RootEvidence[], home: string,
  resolve: (p: string) => { real: string; devino: string | null } = p => ({ real: canonicalExisting(p), devino: devino(canonicalExisting(p)) })): GuardVerdict {
  const top = shellInvocations(withoutHeredocBodies(command));
  if (!top) return { refuse: false }; // top-level malformed/heredoc text is not a nested executable string; never guess
  const judge = (inv: Invocation, inherited: Record<string,string>, depth: number): GuardVerdict | null => {
    if (depth > 8 || !inv.argv.length) return depth > 8 ? nestedUnparsed(inv.argv.map(w => w.text).join(" ")) : null;
    const vars = { ...inherited, ...inv.vars };
    let words = inv.argv.slice();
    const val = (w: Word | undefined) => w ? expandWord(w, vars, home).value : null;
    let prog = path.basename(val(words[0]) || "");
    const skipPairOptions = (start: number, withValue: Set<string>) => {
      let i=start;
      while (i<words.length && val(words[i])?.startsWith("-")) {
        const x=val(words[i])!; if (x === "--") return i+1;
        const key=x.split("=")[0]; i += withValue.has(key) && !x.includes("=") ? 2 : 1;
      }
      return i;
    };
    if (prog === "sudo") {
      const i=skipPairOptions(1,new Set(["-u","--user","-g","--group","-C","--close-from","-D","--chdir","-h","--host","-p","--prompt","-r","--role","-t","--type"])); words=words.slice(i); prog=path.basename(val(words[0])||"");
    } else if (prog === "timeout") {
      let i=skipPairOptions(1,new Set(["-s","--signal","-k","--kill-after"])); if(i<words.length)i++; words=words.slice(i); prog=path.basename(val(words[0])||"");
    } else if (prog === "nice") {
      const i=skipPairOptions(1,new Set(["-n","--adjustment"])); words=words.slice(i); prog=path.basename(val(words[0])||"");
    } else if (prog === "env") {
      let i=1;
      while(i<words.length){const x=val(words[i]); if(!x)break; if(x==="--"){i++;break;} if(["-u","--unset","-C","--chdir","-S","--split-string"].includes(x)){i+=2;continue;} if(x.startsWith("-")||/^[A-Za-z_]\w*=/.test(x)){if(/^[A-Za-z_]\w*=/.test(x)){const k=x.indexOf("=");vars[x.slice(0,k)]=x.slice(k+1);} i++;continue;} break;}
      words=words.slice(i); prog=path.basename(val(words[0])||"");
    }
    if (["nohup","command","exec"].includes(prog)) { const i=skipPairOptions(1,new Set()); words=words.slice(i); prog=path.basename(val(words[0])||""); }
    if (prog === "xargs") { const i=skipPairOptions(1,new Set(["-n","--max-args","-L","--max-lines","-P","--max-procs","-I","--replace","-s","--max-chars","-E","--eof"])); words=words.slice(i); prog=path.basename(val(words[0])||""); }
    if (["bash","sh","zsh","dash"].includes(prog)) {
      const ci=words.findIndex((w,i)=>i>0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(val(w)||""));
      if(ci>=0 && words[ci+1]) { const body=words[ci+1].text, nested=shellInvocations(body); if(!nested)return nestedUnparsed(body); for(const n of nested){const r=judge(n,vars,depth+1);if(r)return r;} }
      return null;
    }
    if (prog === "eval") {
      const body=words.slice(1).map(w=>w.text).join(" "), nested=shellInvocations(body); if(!nested)return nestedUnparsed(body); for(const n of nested){const r=judge(n,vars,depth+1);if(r)return r;} return null;
    }
    const concrete=words.map(w=>expandWord(w,vars,home));
    const argv=concrete.map(x=>x.value ?? "__DYNAMIC__");
    const op=operation(argv); if(!op)return null;
    const targets=optionTargets(argv,op);
    for(let ti=0;ti<targets.length;ti++){
      const raw=targets[ti];
      let candidate=raw;
      if(raw==="__DYNAMIC__"){
        const index=argv.indexOf(raw,1); candidate=concrete[index]?.staticPrefix || "";
        if(!candidate)continue;
      }
      const normalized = candidate === "/" || /^\/+\.?$/.test(candidate) ? "/" : candidate.replace(/\/+$/, "");
      const abs=path.resolve(cwd,normalized || "."), ev=resolve(abs);
      for(const root of roots){
        const hit=isAncestorOrSame(abs,root.lexical)||isAncestorOrSame(ev.real,root.real)||(!!ev.devino&&!!root.devino&&ev.devino===root.devino);
        if(!hit)continue;
        const evidence=`target ${abs} => ${ev.real} dev:ino=${ev.devino??"missing"}; protected ${root.name} => ${root.real} dev:ino=${root.devino??"missing"}`;
        return {refuse:true,operation:op,target:candidate,root:root.name,evidence,reason:`REFUSED ${op} at protected root ${root.name}. ${evidence}. Safer alternative: create an owner-only /tmp workspace and delete only that exact child path; for a staged install/revert use safe_replace.py or cas_swap.py with pinned preimage.`};
      }
    }
    return null;
  };
  for(const inv of top){const r=judge(inv,{},0);if(r)return r;}
  return {refuse:false};
}

const ROOTS = protectedRoots();
export default function destructiveGuard(pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event?.toolName !== "bash") return;
    const command = String(event?.input?.command ?? "");
    if (!/\b(rm|find|rsync|mv|chmod|chown)\b/.test(command)) return;
    const v = classifyCommand(command, String(ctx?.cwd ?? process.cwd()), ROOTS, os.homedir());
    if (v.refuse) return { block: true, reason: v.reason };
  });
}
