// wos-open-loop — F1 open-loop stop guard + F2 per-session ledger + F3 resume-on-interrupt.
//
// INCIDENT (2026-09-22, DIR-example, example-project): the turn ended with
//   "H1 还没有验证。能证实或推翻它的检验是：…"   (Doc: "H1 is the test that would confirm or kill it")
// The test was reversible, authorised and unblocked, and it was not run. A Butler handover arrived
// next, DIR-example answered it, and H1 was lost until the owner asked. When run, H1 was FALSIFIED and the
// headline changed. `wos-authority-continuation` (wos-guards.ts) only matches OFFER phrasing
// ("shall I", "unless you want"); a DECLARATIVE deferral passed straight through it.
// Brief: ~/.wos-runtime/briefs/request 2026-09-22.md
//
// DESIGN RULE (DIR-wos): a keyword alone never fires. Every marker hit must RESOLVE to one of
//   executed   — the item ran this turn (tool receipt carrying its key, or a non-negated result)
//   dispatched — a dispatch receipt names the item / the named child is present
//   scheduled  — a job id is named with a scheduling verb
//   owned      — handed back to the owner / a named owner, or truly blocked WITH the reason
// Anything left `open` is written to the ledger and — once per turn — a continuation steer is
// injected through the same `agent_settled` + `pi.sendUserMessage()` actuator the authority guard
// uses. Quoted text is stripped first: someone else's words are not this agent's deferral.
//
// F2  ledger: ~/.wos-runtime/director/open_loops/<session>.jsonl (append-only; open/resolved rows)
// F3  the `context` hook appends a transient tail message while open rows exist; once an inbound
//     message (user / steer / handover / subagent result) arrives after the row was opened it reads
//     "Resume after reply: <rows>". Transient means it is recomputed from the ledger on every LLM
//     call, so it survives compaction by construction; `session_compact` additionally persists one
//     copy into the post-compaction transcript. The OM compaction hook is NOT edited.
//
// KILL SWITCH (either): env WOS_OPEN_LOOP_GUARD=0|off   or   touch ~/.wos-runtime/director/KILL_SWITCH_OPEN_LOOP_GUARD
// The estate-wide ~/.wos-runtime/butler/guards.off also disables it. Revert: ~/.wos-runtime/director/open_loop_guard_revert.sh
//
// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const WDB = path.join(os.homedir(), ".wos-runtime");
const KILL_FILE = path.join(WDB, "director", "KILL_SWITCH_OPEN_LOOP_GUARD");
const GUARDS_OFF = path.join(WDB, "butler", "guards.off");
const GATE_LOG = path.join(WDB, "state", "gate_hits.jsonl");   // local canonical (request 2026-10-01)
export const OPEN_LOOP_PREFIX = "[wos-open-loop]";
const CONTEXT_TYPE = "wos-open-loops";
const MAX_ROWS_SHOWN = 5;
const ROW_TEXT_MAX = 220;
const ROW_TTL_MS = 7 * 24 * 3600 * 1000;

function ledgerDir(): string {
  return process.env.WOS_OPEN_LOOP_DIR || path.join(WDB, "director", "open_loops");
}

export function disabled(): boolean {
  try {
    const env = String(process.env.WOS_OPEN_LOOP_GUARD ?? "").toLowerCase();
    if (env === "0" || env === "off" || env === "false") return true;
    if (process.env.WOS_GUARDS === "off") return true;
    return fs.existsSync(process.env.WOS_OPEN_LOOP_KILL_FILE || KILL_FILE) || fs.existsSync(GUARDS_OFF);
  } catch {
    return false;
  }
}

function textOf(content: any): string {
  try {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (typeof c === "string" ? c : c?.type === "text" && typeof c?.text === "string" ? c.text : ""))
        .join("\n");
    }
    return "";
  } catch {
    return "";
  }
}

// ── detection ─────────────────────────────────────────────────────────────────────────────
// Next-step markers. Narrow on purpose: each is a phrase that names work still to be done.
const MARKER_EN =
  /\b(?:(?:my|the|our)\s+(?:honest\s+|obvious\s+|real\s+)?next\s+(?:test|step|check|experiment|probe)\s+(?:is|would\s+be|will\s+be|remains)|next\s+(?:test|step|check)\s*(?:is\b|[:：]|,?\s+i(?:'ll|\s+will)\b)|next\s+i(?:'ll|\s+will)\s+\w+|would\s+(?:confirm|kill|falsify|refute|settle|decide|distinguish|discriminate)\b|confirm\s+or\s+(?:kill|refute|falsify|reject)|decisive\s+(?:test|check|experiment)|(?:is|are|remains?|still|currently)\s+pending|pending\s+(?:verification|validation|test|run|refresh|check|confirmation|re-?run)|(?:still|yet|remains?|is|are)\s+(?:still\s+)?to\s+be\s+(?:verified|validated|tested|confirmed|re-?run|checked)|(?:not\s+yet|hasn'?t\s+been|has\s+not\s+been|haven'?t\s+been|have\s+not\s+been|yet\s+to\s+be|still\s+(?:needs?|has)\s+to\s+be)\s+(?:run|tested|verified|validated|checked|executed|confirmed|refreshed)|remains?\s+to\s+be\s+(?:tested|verified|run|checked|confirmed)|follow[- ]up\s+(?:test|check|run|analysis|query)|still\s+(?:need|needs)\s+to\s+(?:run|test|verify|check|refresh))/i;
const MARKER_ZH =
  /下一步(?=\s*(?:是|就|[:：]|去|要|做|仍是|只|先|再|我|打算|会))|我(?:的)?下一步|待验证|待确认|待跑|有待(?:验证|确认|检验)|(?:还|仍)(?:没|未)有?(?:验证|跑|测试|检验|确认|执行)|尚未(?:验证|跑|执行|确认|检验)|(?:能|可以|可)?证实或推翻|决定性(?:的)?(?:检验|测试|实验)|接下来(?:要|会|需要|应该|该|就|再)(?!做什么)|后续(?:要|需要|再)(?:验证|跑|检验|确认|刷新)/;

// Hand-back to the owner (or "you") as the decider — a legitimate return of human judgment.
const HAND_BACK =
  /\b(?:owner|you)\s+(?:decides?|to\s+decide|chooses?|to\s+choose|picks?|approves?|ratif\w*|signs?\s*off|makes?\s+the\s+call|owns?)\b|\b(?:your|owner'?s)\s+(?:call|decision|choice|approval|ratification|sign-?off|judg(?:e)?ment)\b|\bneeds?\s+(?:your|owner'?s)\b|\bowner[- ]owned\b|\bfor\s+owner\s+to\b|\bawaiting\s+(?:your|owner'?s)\b|\bif\s+(?:you|owner|codex|the\s+verifier)\s+wants?\b|outside\s+the\s+fleet|需要你|等你|由你|你来(?:定|决定|选)|你决定|请你(?:决定|确认|选)|待你|owner\s*(?:决定|拍板|确认)|归你(?:决定)?|fleet\s*外/i;
// Handed to a named owner that is not this agent (verifier / director / routed child).
const NAMED_OWNER =
  /\b(?:codex|verifier)\s+(?:verif\w*|checks?|reviews?)\b|\b(?:routed|handed|dispatched|assigned|delegated|sent)\s+to\s+[`'"]?[\w@.-]+|\bowner\s*[:=]\s*\S+|\bDIR-[A-Za-z0-9_-]+|已(?:派|交|转)给|交给\s*\S+|派给\s*\S+/i;
// First-person commitment: "I'll check DIR-example" is this agent's own step, not a hand-off.
const SELF_STEP = /\bi(?:'ll|\s+will|\s+am\s+going\s+to)\b|\bnext\s+i\b|我(?:的)?下一步|我(?:会|来|去|要|再)|我下一步/i;
// Narration of a past plan, a contingency, or a question is not an open commitment.
const NARRATIVE = /本来|原本|原来打算|\boriginally\b|\bwas\s+going\s+to\b/i;
const CONTINGENT = /^\W*(?:如果|若|假如|一旦|if\b|once\b|when\b|should\s+\w+\s+(?:pass|fail))/i;
const QUESTION = /[?？]\s*\**\s*$/;
// Truly blocked, with the reason in the same sentence.
const BLOCKED =
  /\b(?:blocked\s+(?:by|on)|waiting\s+(?:on|for)\s+(?:access|approval|permission|a\s+reply|reply|input|the\s+owner|\w+\s+to\s+(?:reply|approve|grant))|access\s+denied|permission\s+denied|no\s+access|cannot\s+(?:access|reach|run)\b|can'?t\s+(?:access|reach|run)\b|requires?\s+(?:human|your|owner'?s)\s+(?:access|approval|decision)|irreversible)\b|被\S{0,8}阻塞|阻塞于|卡在(?:权限|审批)|没有权限|无权限|等待\S{0,10}(?:权限|审批|回复|授权)/i;
// A time-shaped wait is NOT a blocker: it needs a wake-up (job id), which is what the incident lacked.
const TIME_WAIT = /\b(?:after|until|on\s+or\s+after|once\s+.{0,20}matur\w*|matur\w*|in\s+\d+\s+(?:days?|hours?))\b|\d{1,2}[-/]\d{1,2}\s*(?:之后|以后|后)|成熟/i;
const SCHEDULED =
  /\b(?:scheduled|cron(?:tab)?|one-?shot|job(?:\s+id)?|wos_defer|at\s+\d{1,2}:\d{2}\s*(?:UTC|CE?S?T|PT))\b|定时|排成|已排|一次性\s*cron/i;
const JOB_ID = /`[A-Za-z0-9][\w.:-]{3,80}`|\bjob[_\s-]?id\s*[:=]\s*\S+|\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/i;
const RESULT_DONE =
  /\b(?:ran|re-?ran|executed|was\s+(?:run|tested|executed|checked|verified)|were\s+(?:run|tested)|tested\s+and|falsified|refuted|confirmed|verified|completed|finished|passed|dispatched|scheduled|done)\b|推翻了|被推翻|证实了|已(?:跑|验证|执行|完成|证实|推翻|派|排|更新)|跑完|跑了|验证了|完成了|补跑|已经做|做完了/i;
const NEGATION =
  /\b(?:not\s+yet|hasn'?t|has\s+not|haven'?t|have\s+not|yet\s+to|still\s+(?:needs?|has)\s+to|not\s+(?:run|tested|verified|executed)|never\s+ran|no\s+longer)\b|还(?:没|未)|尚未|没有(?:验证|跑|执行|做)|未(?:验证|跑|执行)|待(?:验证|跑|确认)/i;
const IN_FLIGHT =
  /已在.{0,12}(?:运行|跑)|在运行|\b(?:child(?:ren)?|sub-?agents?|workers?)\b.{0,40}\b(?:running|in\s+flight|in\s+progress|dispatched|working)\b|\b(?:still\s+running|in\s+flight)\b|(?:子任务|子代理|子\s*agent).{0,12}(?:在跑|运行中|进行中)|(?:还没|尚未)跑完|正在跑/i;
const isIdKey = (k: string) => /^[A-Z]{1,4}\d{1,3}[a-z]?$/.test(k) || /^req-/.test(k);
const DISPATCH_TOOL = /^(?:subagent|subagent_message|wos_spawn|wos_send|dispatch|handoff|task|agent)$/i;
const SCHEDULE_CMD = /\bcrontab\b|wos_defer|cron-jobs\/|\bsystemd-run\b|\bat\s+-f\b/;

/** Remove other people's words: code, block quotes, inline quoted spans. */
export function stripQuoted(text: string): string {
  let s = String(text ?? "");
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`{1}[^`\n]{0,400}`/g, (m) => m); // inline code kept: it is often the key/job id
  s = s
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n");
  // Quoted spans (ASCII, curly, CJK corner brackets). Bounded length so a stray quote does not eat a page.
  s = s.replace(/"[^"\n]{1,300}"/g, " ");
  s = s.replace(/“[^”\n]{1,300}”/g, " ");
  s = s.replace(/「[^」\n]{1,300}」/g, " ");
  s = s.replace(/『[^』\n]{1,300}』/g, " ");
  s = s.replace(/(^|[\s(])'[^'\n]{2,200}'(?=[\s).,;:!?]|$)/g, "$1 ");
  return s;
}

// ── outbound content (request 2026-09-23) ─────────────────
// 🔴 2026-09-23 12:58Z, Butler: row 34ab3b143f "please confirm or refute each point from" was lifted
// out of ~/.wos-runtime/briefs/request 2026-09-23.md — a brief whose frontmatter says
// `to: DIR-example`, delivered by `wos_send --file <that path>` in the same turn. The imperative was
// Butler's ask OF DIR-example, carried text, not Butler's own deferral. Match the referent: content that is
// addressed to ANOTHER agent (a file passed to wos_send --file, a file/heredoc whose header addresses
// another agent, a subagent task, a block marked outbound) opens no loop. The agent's OWN first-person
// commitment inside such content ("I'll re-run after you reply") still does (SELF_STEP).
const FM_TO = /^\uFEFF?---\s*\n([\s\S]{0,4000}?)\n---\s*(?:\n|$)/;
const RELAY_HEAD = /^\s*(?:<!--wos-origin[^>]*-->\s*)?\[\s*[\w@.-]+\s*(?:->|→)\s*([\w@.-]+)\s*\]/;
const OUTBOUND_PARA_HEAD =
  /^\s*(?:\[\s*[\w@.-]+\s*(?:->|→)\s*[\w@.-]+\s*\]|\**(?:to|brief\s+to|handover\s+to|relay\s+to|message\s+to|ask\s+(?:to|of))\s+[`'"]?(?:DIR-[\w-]+|Butler|[\w-]+-(?:verif\w*|fix|child|worker))\b[^:\n]{0,40}[:：]|(?:给|发给|转给|交给)\s*(?:DIR-[\w-]+|Butler)[^:：\n]{0,20}[:：])/i;
const SEND_CMD = /\bwos_send(?:\.py)?\b/;
const CHILD_TOOL = /^(?:subagent|subagent_message|wos_spawn|wos_send|handoff)$/i;

function selfNames(): Set<string> {
  const out = new Set<string>(["self", "me"]);
  for (const v of [process.env.WOS_DIRECTOR, process.env.PI_AGENT]) if (v && String(v).trim()) out.add(String(v).trim().toLowerCase());
  return out;
}
function normPath(p: string): string {
  let s = String(p ?? "").trim().replace(/^['"]|['"]$/g, "");
  s = s.replace(/^~(?=\/)/, os.homedir()).replace(/^\$HOME(?=\/)/, os.homedir()).replace(/^\$\{HOME\}(?=\/)/, os.homedir());
  try { return path.resolve(s); } catch { return s; }
}
/** Who a body is addressed to, from its own header: frontmatter `to:` or a `[A -> B]` relay head. */
export function addressedTo(body: string): string {
  const s = String(body ?? "");
  const fm = s.match(FM_TO);
  if (fm) {
    const to = fm[1].match(/^to\s*:\s*(.+)$/im);
    if (to) return to[1].trim().replace(/^['"`]|['"`]$/g, "").split(/[\s,(]/)[0];
  }
  const rh = s.split("\n").slice(0, 3).join("\n").match(RELAY_HEAD);
  return rh ? rh[1] : "";
}
function addressedToOther(body: string): string {
  const to = addressedTo(body);
  return to && !selfNames().has(to.toLowerCase()) ? to : "";
}
function cmdOf(r: any): string {
  const i = r?.input ?? {};
  return typeof i === "string" ? i : String(i?.command ?? i?.cmd ?? "");
}
/** Paths handed to wos_send as the payload this turn (`--file P`, `--file=P`, or a wos_send tool's file). */
export function outboundPaths(receipts: any[]): Set<string> {
  const out = new Set<string>();
  for (const r of receipts ?? []) {
    if (/^wos_send$/i.test(String(r?.name ?? "")) && r?.input?.file) out.add(normPath(r.input.file));
    const c = cmdOf(r);
    if (!SEND_CMD.test(c)) continue;
    for (const m of c.matchAll(/--file(?:=|\s+)(?:'([^']+)'|"([^"]+)"|(\S+))/g)) out.add(normPath(m[1] ?? m[2] ?? m[3]));
  }
  return out;
}
/** Heredoc bodies written to a file by bash: [{path, body}]. */
export function heredocWrites(cmd: string): { path: string; body: string }[] {
  const out: { path: string; body: string }[] = [];
  const re = /(?:cat|tee(?:\s+-a)?)\s*(?:>>?\s*)?(?:(?:'([^']+)'|"([^"]+)"|([^\s<>|;&]+))\s*)?<<-?\s*['"]?([A-Za-z_][\w]*)['"]?[^\n]*\n([\s\S]*?)\n\s*\4\s*(?:\n|$)/g;
  for (const m of String(cmd ?? "").matchAll(re)) {
    const p = m[1] ?? m[2] ?? m[3] ?? "";
    // `cat > P <<X` puts P before the heredoc; `cat <<X > P` puts it after on the same line.
    const after = m[0].split("\n")[0].match(/>>?\s*(?:'([^']+)'|"([^"]+)"|([^\s<>|;&]+))\s*$/);
    const dest = p || (after ? (after[1] ?? after[2] ?? after[3]) : "");
    out.push({ path: dest ? normPath(dest) : "", body: m[5] });
  }
  return out;
}
function fileHead(p: string): string {
  try {
    const fd = fs.openSync(p, "r");
    try { const b = Buffer.alloc(4096); const n = fs.readSync(fd, b, 0, 4096, 0); return b.slice(0, n).toString("utf8"); }
    finally { fs.closeSync(fd); }
  } catch { return ""; }
}
/** Is this write/edit receipt's content addressed to another agent? Returns the reason or "". */
export function outboundReason(r: any, outPaths: Set<string>): string {
  const p = r?.input?.path ? normPath(r.input.path) : "";
  if (p && outPaths.has(p)) return `payload of wos_send --file ${p}`;
  const body = String(r?.input?.content ?? "");
  let to = addressedToOther(body);
  if (!to && p && !body) to = addressedToOther(fileHead(p)); // edit: the header lives in the file
  return to ? `addressed to ${to}` : "";
}
/** Every body this turn addressed to another agent — the referent set for carried text. */
export function outboundBodies(receipts: any[]): string[] {
  const rs = receipts ?? [];
  const outPaths = outboundPaths(rs);
  const bodies: string[] = [];
  for (const r of rs) {
    const name = String(r?.name ?? "");
    const i = r?.input ?? {};
    if (/^(?:write|edit)$/i.test(name) && outboundReason(r, outPaths)) {
      bodies.push(String(i?.content ?? (Array.isArray(i?.edits) ? i.edits.map((e: any) => e?.newText ?? "").join("\n") : i?.newText ?? "")));
    } else if (CHILD_TOOL.test(name)) {
      bodies.push(String(i?.task ?? i?.message ?? i?.text ?? i?.prompt ?? ""));
    }
    const c = cmdOf(r);
    for (const h of heredocWrites(c)) {
      if ((h.path && outPaths.has(h.path)) || addressedToOther(h.body) || (!h.path && SEND_CMD.test(c))) bodies.push(h.body);
    }
    if (SEND_CMD.test(c)) for (const m of c.matchAll(/--text(?:=|\s+)(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g)) bodies.push(m[1] ?? m[2] ?? "");
  }
  return bodies.filter((b) => b && b.trim().length >= 12);
}
const squash = (s: string) => String(s ?? "").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
/** A sentence is carried when it appears verbatim inside a body addressed to another agent. */
export function isCarried(sentence: string, bodies: string[]): boolean {
  if (!bodies.length) return false;
  const flat = bodies.map(squash);
  const inBody = (x: string) => x.length >= 16 && flat.some((b) => b.includes(x));
  if (inBody(squash(sentence))) return true;
  // "The ask, verbatim: please confirm or refute …" — the marker-bearing CLAUSE is the carried part.
  return String(sentence).split(/[:：;；—–]|,\s|，/).some((c) => hasMarker(c) && inBody(squash(c)));
}
/** Drop paragraphs the agent marked as outbound ("[Butler -> DIR-example] …", "To DIR-example: …"). */
export function stripOutboundParas(text: string): string {
  return String(text ?? "").split(/\n\s*\n/).filter((p) => !OUTBOUND_PARA_HEAD.test(p)).join("\n\n");
}

export function sentences(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[。！？!?；;])|\n+|(?<=\.)\s+(?=[A-Z*`(\[])/)
    .map((x) => x.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim())
    .filter((x) => x.length >= 4);
}

export function keyTokens(sentence: string): string[] {
  const out = new Set<string>();
  for (const m of String(sentence).matchAll(/(?<![A-Za-z0-9])([A-Z]{1,4}\d{1,3}[a-z]?)(?![A-Za-z0-9])/g)) out.add(m[1]);
  for (const m of String(sentence).matchAll(/`([^`\s]{3,80})`/g)) out.add(m[1]);
  for (const m of String(sentence).matchAll(/\breq-[\w-]{6,}/g)) out.add(m[0]);
  return [...out];
}

function receiptText(r: any): string {
  try {
    return `${r?.name ?? ""} ${typeof r?.input === "string" ? r.input : JSON.stringify(r?.input ?? {})}`;
  } catch {
    return String(r?.name ?? "");
  }
}

function hasMarker(s: string): boolean {
  return MARKER_EN.test(s) || MARKER_ZH.test(s);
}

/**
 * Classify one marker-bearing sentence. Returns {status, evidence}; status "open" means the
 * deferral is unresolved. Receipts are this turn's tool calls: [{name, input}].
 */
export function resolveHit(sentence: string, receipts: any[]): { status: string; evidence: string } {
  const s = String(sentence);
  const keys = keyTokens(s);
  const rs = Array.isArray(receipts) ? receipts : [];
  // Receipts that merely WRITE the deferral (e.g. the Doc sentence itself) are not execution.
  const workReceipts = rs.filter((r) => !hasMarker(receiptText(r)));

  if (HAND_BACK.test(s)) return { status: "owned", evidence: "hand-back: " + (s.match(HAND_BACK)?.[0] ?? "") };
  if (QUESTION.test(s)) return { status: "owned", evidence: "question to the reader" };
  if (NARRATIVE.test(s)) return { status: "owned", evidence: "narration of a past plan" };
  if (CONTINGENT.test(s)) return { status: "owned", evidence: "contingent on an unmet condition" };

  // dispatched: a dispatch receipt carrying one of the item's keys, or the child name in the sentence.
  const dispatches = rs.filter((r) => DISPATCH_TOOL.test(String(r?.name ?? "")) ||
    /wos_send\.py|wos_spawn/.test(receiptText(r)));
  for (const d of dispatches) {
    const dt = receiptText(d);
    const childName = String(d?.input?.name ?? "");
    const hitKey = keys.find((k) => dt.includes(k));
    if (hitKey) return { status: "dispatched", evidence: `dispatch ${d?.name}:${childName || "?"} carries ${hitKey}` };
    if (childName && s.includes(childName)) return { status: "dispatched", evidence: `child ${childName} named` };
  }
  if (NAMED_OWNER.test(s) && !SELF_STEP.test(s)) return { status: "owned", evidence: "named owner: " + (s.match(NAMED_OWNER)?.[0] ?? "") };

  const negated = NEGATION.test(s);
  if (SCHEDULED.test(s) && JOB_ID.test(s) && !negated) {
    return { status: "scheduled", evidence: "job: " + (s.match(JOB_ID)?.[0] ?? "") };
  }
  if (rs.some((r) => SCHEDULE_CMD.test(receiptText(r))) && SCHEDULED.test(s)) {
    return { status: "scheduled", evidence: "schedule receipt this turn" };
  }

  if (BLOCKED.test(s) && !TIME_WAIT.test(s.replace(BLOCKED, ""))) {
    return { status: "owned", evidence: "blocked: " + s.slice(0, 160) };
  }

  // Work already in flight (a running child / job) is awaited, not deferred: the harness delivers it.
  if (IN_FLIGHT.test(s)) return { status: "dispatched", evidence: "in flight: " + (s.match(IN_FLIGHT)?.[0] ?? "") };

  // executed: a non-marker tool receipt carries the item's ID-LIKE key (H1, F12, req-…). Backticked
  // code tokens do not count: the subject of an investigation appears in its receipts whether or
  // not the deferred step ran (measured on DIR-wos 2026-09-22 finals: 3 real deferrals were wrongly
  // "executed" by `observer-trigger` / `buildContextEntries()` appearing in reads).
  const execKey = keys.filter(isIdKey).find((k) => workReceipts.some((r) => receiptText(r).includes(k)));
  if (execKey) return { status: "executed", evidence: `receipt carries ${execKey}` };
  // … or the sentence reports a completed result (not negated) and work happened this turn.
  if (!negated && RESULT_DONE.test(s) && rs.length > 0) {
    return { status: "executed", evidence: "result reported: " + (s.match(RESULT_DONE)?.[0] ?? "") };
  }
  return { status: "open", evidence: "" };
}

export type Hit = { text: string; key: string; status: string; evidence: string; source: string };

/**
 * Analyse the final assistant message (+ this turn's written files when cheap).
 * Hits sharing a key token collapse to one item: an item is open only if NONE of its sentences resolves it.
 */
export function analyzeTurn(finalText: string, receipts: any[], opts: any = {}): Hit[] {
  const hits: Hit[] = [];
  const carried = outboundBodies(receipts ?? []);
  const addFrom = (body: string, source: string) => {
    // A keyless marker sentence inherits the key of the sentence just before it in the same
    // paragraph ("H1 is unverified. The test that would confirm it is …" is ONE item).
    for (const para of stripOutboundParas(stripQuoted(body)).split(/\n\s*\n/)) {
      let prevKey = "";
      for (const s of sentences(para)) {
        const keys = keyTokens(s);
        const key = keys[0] ?? prevKey;
        prevKey = keys[0] ?? "";
        if (!hasMarker(s)) continue;
        // Text restated from a brief/handover/child task addressed to another agent is that
        // agent's work, not this agent's deferral — unless it is this agent's own first-person step.
        if (!SELF_STEP.test(s) && isCarried(s, carried)) continue;
        const v = resolveHit(key && !keys.length ? `${s} ${key}` : s, receipts);
        hits.push({ text: s.slice(0, ROW_TEXT_MAX), key, status: v.status, evidence: v.evidence, source });
      }
    }
  };
  addFrom(finalText, "final");
  if (opts.scanFiles) {
    // Only STRONG markers in written prose: section headings like "Next steps" are too common in docs.
    const STRONG = /\bwould\s+confirm\b|confirm\s+or\s+(?:kill|refute)|decisive\s+test|the\s+test\s+that\s+would|待验证|证实或推翻|决定性(?:的)?检验/i;
    const outPaths = outboundPaths(receipts ?? []);
    for (const r of receipts ?? []) {
      if (!/^(?:write|edit)$/i.test(String(r?.name ?? ""))) continue;
      const body = String(r?.input?.content ?? r?.input?.newText ??
        (Array.isArray(r?.input?.edits) ? r.input.edits.map((e: any) => e?.newText ?? "").join("\n") : ""));
      // A file addressed to another agent carries THEIR work: only this agent's own first-person
      // step inside it can open a loop here (34ab3b143f, Butler 2026-09-23).
      const outbound = outboundReason(r, outPaths);
      for (const s of sentences(stripQuoted(body))) {
        if (!STRONG.test(s)) continue;
        if (outbound && !SELF_STEP.test(s)) continue;
        const v = resolveHit(s, receipts);
        hits.push({ text: s.slice(0, ROW_TEXT_MAX), key: keyTokens(s)[0] ?? "", status: v.status, evidence: v.evidence, source: "file:" + String(r?.input?.path ?? "") });
      }
    }
  }
  // Collapse by key: any resolving sentence resolves the item.
  const byKey = new Map<string, Hit>();
  const out: Hit[] = [];
  for (const h of hits) {
    if (!h.key) { out.push(h); continue; }
    const prev = byKey.get(h.key);
    if (!prev) { byKey.set(h.key, h); continue; }
    if (prev.status === "open" && h.status !== "open") byKey.set(h.key, h);
    else if (prev.status === "open" && h.status === "open" && !prev.text.includes(h.text)) {
      byKey.set(h.key, { ...prev, text: `${prev.text} ${h.text}`.slice(0, ROW_TEXT_MAX) });
    }
  }
  return [...out, ...byKey.values()];
}

// ── ledger (F2) ───────────────────────────────────────────────────────────────────────────
function safeSession(s: string): string {
  return String(s || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}
export function ledgerPath(session: string): string {
  return path.join(ledgerDir(), `${safeSession(session)}.jsonl`);
}
function rowId(session: string, h: Hit): string {
  return crypto.createHash("sha1").update(`${session}\n${h.key || h.text}`).digest("hex").slice(0, 10);
}
export function readLedger(session: string): any[] {
  try {
    const p = ledgerPath(session);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}
function appendRows(session: string, rows: any[]) {
  if (!rows.length) return;
  try {
    fs.mkdirSync(ledgerDir(), { recursive: true });
    fs.appendFileSync(ledgerPath(session), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  } catch {
    /* fail-open */
  }
}
/** Latest row per id whose event is still "open" (and not older than the TTL). */
export function openRows(session: string, now = Date.now()): any[] {
  const last = new Map<string, any>();
  for (const r of readLedger(session)) if (r?.id) last.set(r.id, r);
  return [...last.values()]
    .filter((r) => r.event === "open" && now - Number(r.ts_ms ?? 0) < ROW_TTL_MS)
    .sort((a, b) => Number(a.ts_ms) - Number(b.ts_ms));
}

// ── gate_hits.jsonl IS LOCAL (request 2026-10-01) ────────────────────────────────
// 🔴 10 of 37 post-F1 main-thread stalls ≥11 s were appendFileSync on butler/state/gate_hits.jsonl —
// a symlink into the wisdom-os FUSE mount. The canonical file is now ~/.wos-runtime/state/gate_hits.jsonl
// (a real file on local disk); butler/state/gate_hits.jsonl is a compat symlink to it, and
// harness/gate_hits_mirror.py copies rows to 02_Cases/_ledgers/gate_hits.jsonl from cron, off the hot path.
// localLedgerPathOk() refuses any target that is under a FUSE mount or reached through a symlink WITHOUT
// touching the mount: string-prefix check first, then lstat (never stat) of each directory below $HOME,
// then O_NOFOLLOW on the file. A refused target diverts to ~/.wos-runtime/state/gate_hits.divert.jsonl
// (the mirror merges it into the canonical file); a row is never written into wisdom-os from here.
const GATE_HITS_FUSE_ROOTS: string[] = (() => {
  const out = new Set<string>([path.join(os.homedir(), "wisdom-os")]);
  for (const r of String(process.env.WOS_GDRIVE_ROOTS ?? "").split(":")) if (r) out.add(path.resolve(r));
  try {   // procfs is local; read once at load
    for (const ln of fs.readFileSync("/proc/self/mounts", "utf8").split("\n")) {
      const f = ln.split(" ");
      if (f.length > 2 && /^fuse/.test(f[2])) out.add(f[1].replace(/\\([0-7]{3})/g, (_m: string, o: string) => String.fromCharCode(parseInt(o, 8))));
    }
  } catch { /* no mounts table: the literal ~/wisdom-os root still applies */ }
  return [...out].filter((r) => r && r !== "/");
})();
// Divert order: a local non-tmp file first (survives reboot; refused too if its own dir is the unsafe one), then /tmp.
const GATE_HITS_DIVERT: string[] = process.env.WOS_GATE_HITS_DIVERT ? process.env.WOS_GATE_HITS_DIVERT.split(":").filter(Boolean) : [
  path.join(os.homedir(), ".wos-runtime", "state", "gate_hits.divert.jsonl"),
  path.join("/tmp", `wos-gate-hits-divert-${typeof process.getuid === "function" ? process.getuid() : "u"}.jsonl`)];
function gateHitsUnderFuse(p: string): boolean {
  return GATE_HITS_FUSE_ROOTS.some((r) => p === r || p.startsWith(r.endsWith("/") ? r : r + "/"));
}
/** true iff `file` is a local path whose parent directories (below $HOME, or below / outside it) are real
 *  directories — never a symlink — and nothing is under a FUSE mount. Never stats through a link. */
function localLedgerPathOk(file: string): boolean {
  try {
    const abs = path.resolve(file);
    if (gateHitsUnderFuse(abs)) return false;
    const home = path.resolve(os.homedir());
    const base = abs.startsWith(home + "/") ? home : "/";
    const rel = path.relative(base, path.dirname(abs));
    let cur = base;
    for (const part of rel ? rel.split(path.sep) : []) {
      cur = path.join(cur, part);
      if (gateHitsUnderFuse(cur)) return false;
      const st = fs.lstatSync(cur, { throwIfNoEntry: false });
      if (!st) return true;                  // missing: mkdir below creates a real directory
      if (!st.isDirectory()) return false;   // a symlink (or a file) in the chain: refuse
    }
    return true;
  } catch { return false; }
}
/** One O_APPEND|O_NOFOLLOW write of `line` to `file`, else to the local divert file; false if neither. */
function localAppend(file: string, line: string): boolean {
  const C = fs.constants;
  for (const target of [file, ...GATE_HITS_DIVERT]) {
    if (!target || !localLedgerPathOk(target)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(target, C.O_WRONLY | C.O_APPEND | C.O_CREAT | C.O_NOFOLLOW, 0o600);
      try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
      return true;
    } catch { /* next target */ }
  }
  return false;
}

// request 2026-10-02 (same defect as -01 in wos-guards): Pi exports PI_SESSION_ID only to the bash
// tool's CHILD env, never into this process, so these rows carried session=null (or an inherited PARENT id). The
// runtime's own SessionManager id is captured at every session_start (startup/reload/new/resume/fork) and preferred;
// env is only the fallback.
let RUNTIME_SESSION_ID: string | null = null;
function noteRuntimeSession(ctx: any): void {
  let id = "";
  try { id = String(ctx?.sessionManager?.getSessionId?.() ?? ""); } catch { /* empty */ }
  RUNTIME_SESSION_ID = id || null;   // a switch to a session with no id must not keep the previous one
}
function rowSession(): string | null {
  return RUNTIME_SESSION_ID ?? process.env.PI_SESSION_ID ?? null;
}

function logGate(detail: string, klass = "open-loop-continuation") {
  try {
    const log = process.env.WOS_OPEN_LOOP_GATE_LOG || GATE_LOG;
    localAppend(log, JSON.stringify({
      ts: new Date().toISOString(), klass, caught_by: "gate",
      synthetic: process.env.WOS_GUARD_TEST === "1", detail: String(detail).slice(0, 200), cmd: "agent_settled",
      session: rowSession(),
        rid: crypto.randomBytes(8).toString("hex"),   // row id: every row unique (an earlier request r4)
    }) + "\n");
  } catch { /* fail-open */ }
}

/** test seam (request 2026-10-01) */
export const __gateHits = { logGate, localLedgerPathOk, localAppend, GATE_LOG, GATE_HITS_DIVERT };

// ── transcript helpers ────────────────────────────────────────────────────────────────────
function isInjected(t: string): boolean {
  return /^\s*\[wos-[a-z-]+\]/.test(String(t ?? ""));
}
function branchOf(ctx: any): any[] {
  try {
    return (ctx?.sessionManager?.getBranch?.() ?? []).map((e: any) => e?.message ?? e).filter(Boolean);
  } catch {
    return [];
  }
}
function sessionIdOf(ctx: any): string {
  try {
    return String(ctx?.sessionManager?.getSessionId?.() || process.env.PI_SESSION_ID || "");
  } catch {
    return String(process.env.PI_SESSION_ID || "");
  }
}
/** Tool calls since the last REAL (non-injected) user message. */
export function receiptsOf(branch: any[]): any[] {
  let start = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]?.role === "user" && !isInjected(textOf(branch[i]?.content))) { start = i; break; }
  }
  const out: any[] = [];
  for (let i = start; i < branch.length; i++) {
    const blocks = Array.isArray(branch[i]?.content) ? branch[i].content : [];
    for (const b of blocks) {
      if (b?.type !== "toolCall" && b?.type !== "tool_use") continue;
      out.push({ name: String(b?.name ?? b?.toolName ?? ""), input: b?.input ?? b?.arguments ?? {} });
    }
  }
  return out;
}

/** Existing open rows that THIS turn resolved (key in receipts, or reported done in the final). */
export function resolveExisting(rows: any[], finalText: string, receipts: any[]): any[] {
  const out: any[] = [];
  const clean = stripQuoted(finalText);
  const sents = sentences(clean);
  for (const r of rows) {
    const key = String(r?.key ?? "");
    if (!key) continue;
    // Strongest evidence first: the final REPORTS the item's result; then an execution receipt;
    // then a dispatch that carries the key.
    const done = sents.find((s) => s.includes(key) && RESULT_DONE.test(s) && !NEGATION.test(s));
    if (done && (receipts ?? []).length) { out.push({ row: r, status: "executed", evidence: "reported: " + done.slice(0, 120) }); continue; }
    const e = isIdKey(key) ? (receipts ?? []).find((x) => !hasMarker(receiptText(x)) && receiptText(x).includes(key)) : null;
    if (e) { out.push({ row: r, status: "executed", evidence: `receipt ${e.name} carries ${key}` }); continue; }
    const d = (receipts ?? []).find((x) => (DISPATCH_TOOL.test(String(x?.name ?? "")) || /wos_send\.py/.test(receiptText(x))) && receiptText(x).includes(key));
    if (d) { out.push({ row: r, status: "dispatched", evidence: `dispatch ${d.name} carries ${key}` }); continue; }
    const own = sents.find((s) => s.includes(key) && (HAND_BACK.test(s) || (BLOCKED.test(s) && !TIME_WAIT.test(s))));
    if (own) out.push({ row: r, status: "owned", evidence: own.slice(0, 160) });
  }
  return out;
}

function renderRows(rows: any[]): string {
  return rows.slice(0, MAX_ROWS_SHOWN).map((r, i) => `${i + 1}) [${r.id}] ${String(r.text).slice(0, ROW_TEXT_MAX)}`).join("\n") +
    (rows.length > MAX_ROWS_SHOWN ? `\n(+${rows.length - MAX_ROWS_SHOWN} more in ${ledgerPath(rows[0]?.session ?? "")})` : "");
}

const RESOLVE_HINT = (session: string) =>
  `Record a the owner-owned or truly blocked item with: /usr/bin/python3 ~/.wos-runtime/director/open_loops.py resolve --session ${session} --id <id> --status owned|blocked --reason "<why>". A wos_send handover to a Director is a dispatch: --status dispatched --evidence handover:<request_id> (or wos-send:<ledger ts>[@<to>]), verified against the wos_send ledger`;

/**
 * Context tail message. Exported so the regression suite drives exactly this.
 * 🔴 Cache-stable (request 2026-09-26 FIX 4): the bytes are a function ONLY of `rows` and the
 * `messages` passed in — the caller passes the prefix before the tail's fixed position — and the timestamp
 * is max(row.ts_ms), never Date.now(). A per-request timestamp or a head that flips on later messages
 * re-wrote the tail every request and broke the provider prompt cache from that point on.
 */
export function contextTail(messages: any[], rows: any[], session: string): any | null {
  if (!rows.length) return null;
  const firstOpen = Math.min(...rows.map((r) => Number(r.ts_ms ?? 0)));
  const inbound = (messages ?? []).some((m: any) =>
    Number(m?.timestamp ?? 0) > firstOpen &&
    ((m?.role === "user" && !isInjected(textOf(m?.content))) ||
      (m?.role === "custom" && m?.customType !== CONTEXT_TYPE && m?.customType !== "wos-active-turn-anchor" && m?.display !== false)));
  const head = inbound
    ? "Resume after reply: answer the inbound message, then resume these open loops from the open-loop ledger —"
    : "Open loops still unresolved (open-loop ledger) —";
  return {
    role: "custom",
    customType: CONTEXT_TYPE,
    content: `${head}\n${renderRows(rows)}\nClose each by running it, dispatching it (name the child), scheduling it (job id), or recording it as the owner-owned/blocked with the reason. ${RESOLVE_HINT(session)}`,
    display: false,
    timestamp: Math.max(...rows.map((r) => Number(r.ts_ms ?? 0))),
  };
}

/**
 * Insert the open-loop tail at a FIXED position: before the first message newer than the newest open row
 * (max ts_ms), or at the end when there is none. Every earlier request ended before those rows existed, so
 * it is a strict prefix of this one; while the open row set is unchanged, position and bytes are identical
 * on every request (append-only from the provider cache's point of view). A change of the row set moves
 * the tail once — one cache break per row-set change, never one per request (FIX 4).
 */
export function placeTail(messages: any[], rows: any[], session: string): any[] {
  const msgs = (messages ?? []).filter((m: any) => !(m?.role === "custom" && m?.customType === CONTEXT_TYPE));
  if (!rows.length) return msgs;
  const newest = Math.max(...rows.map((r) => Number(r.ts_ms ?? 0)));
  let idx = msgs.findIndex((m: any) => Number(m?.timestamp ?? 0) > newest);
  if (idx < 0) idx = msgs.length;
  const tail = contextTail(msgs.slice(0, idx), rows, session);
  return tail ? [...msgs.slice(0, idx), tail, ...msgs.slice(idx)] : msgs;
}

// ── durable one-shot state (see the factory) ─────────────────────────────────────────────────
export const SENT_ENTRY_TYPE = "wos-open-loop-sent";
const PREV_SLOT_MAX_MS = 600_000; // = the helper's maxWaitMs: an older registry entry is stale
// R8.6 (DIR-wos ruling): the ONLY suppressing entry is kind `delivered` (a helper-confirmed branch receipt).
// Every actual hand-off to Pi appends a NON-suppressing kind `attempt` {fp, n}; re-offer stops only when
// `delivered` is on the branch or attempts for that fp on the branch reach MAX_ATTEMPTS (bounded give-up).
export const MAX_ATTEMPTS = 3;
/**
 * R8.7 (DIR-wos ruling, open-loop-r8-verify TEXT_DRIFT): the one-shot / cap key is the LOOP key = session + the
 * SORTED open row ids ONLY. The final text shapes the reminder body, never the key; otherwise text drift on the same
 * open loop reset the cap (verifier probe: 6 hand-offs, 0 delivered, 6 distinct fps). A new row-id set (a loop added
 * or closed) is a new key.
 */
export function loopKey(session: string, rows: any[]): string {
  return `${session}\n${[...new Set(rows.map(loopClass))].sort().join(",")}`;
}
/**
 * R8.8 (DIR-wos ruling, open-loop-r8-verify KEYLESS_REWORD): a KEYLESS row's id is sha1(session + text), so rewording
 * the same unkeyed task minted a new id and a new loop key per wording. A keyless row therefore contributes its stable
 * CLASS instead: the detector that matched (marker-en / marker-zh / strong-file) plus a normalized short anchor (a
 * referenced file name or URL) if one exists, else the class alone (coarser key = fewer reminders; accepted).
 * A keyed row (H1, `job-id`, req-…) keeps its row id (= sha1(session + key), already text-independent).
 */
const ANCHOR = /https?:\/\/[^\s)>\]]+|(?<![\w.])[\w.-]*[A-Za-z0-9_]\.(?:py|ts|tsx|js|mjs|sql|md|json|ipynb|sh|yaml|yml|csv|html)\b/i;
export function detectorOf(row: any): string {
  if (String(row?.source ?? "").startsWith("file:")) return "strong-file";
  const t = String(row?.text ?? "");
  return MARKER_EN.test(t) ? "marker-en" : MARKER_ZH.test(t) ? "marker-zh" : "marker";
}
export function anchorOf(text: string): string {
  const m = String(text ?? "").match(ANCHOR);
  if (!m) return "";
  const a = m[0].replace(/[.,;:!?)]+$/, "").toLowerCase();
  return (/^https?:/.test(a) ? a.replace(/^https?:\/\//, "") : a.split("/").pop() ?? a).slice(0, 80);
}
export function loopClass(row: any): string {
  if (row?.key) return String(row.id);
  const a = anchorOf(row?.text);
  return `c:${detectorOf(row)}${a ? ":" + a : ""}`;
}
/**
 * R8.8 BACKSTOP (DIR-wos ruling): at most BACKSTOP_MAX reminder hand-offs per branch since the last REAL user message
 * (a user entry that is not one of our injected `[wos-…]` messages), whatever the keys. Counts the `attempt` entries
 * after that user entry on the raw branch; a new real user message opens a fresh window.
 */
export const BACKSTOP_MAX = 6;
export function backstopWindow(ctx: any): { n: number; since: string } {
  try {
    const br = ctx?.sessionManager?.getBranch?.() ?? [];
    let last = -1;
    br.forEach((e: any, i: number) => {
      const m = e?.message;
      if (e?.type === "message" && m?.role === "user" && !isInjected(textOf(m?.content))) last = i;
    });
    let n = 0;
    for (let i = last + 1; i < br.length; i++) {
      const e = br[i];
      if (e?.type === "custom" && e?.customType === SENT_ENTRY_TYPE && e?.data?.kind === "attempt") n++;
    }
    return { n, since: last < 0 ? "root" : String(br[last]?.id ?? last) };
  } catch { return { n: 0, since: "?" }; }
}
// getBranch() is the RAW leaf→root path (not the compaction-cut LLM context): custom entries written before a Pi
// compaction, even in its summarized region, stay visible here (real-Pi proof: tools/e2e_compaction_branch.py).
function sentEntriesOnBranch(ctx: any): any[] {
  try {
    return (ctx?.sessionManager?.getBranch?.() ?? []).filter((e: any) =>
      e?.type === "custom" && e?.customType === SENT_ENTRY_TYPE && typeof e?.data?.fp === "string");
  } catch { return []; /* stale ctx: no durable view */ }
}
/** Root fingerprints of reminders DELIVERED (receipt-confirmed) on the current branch. Nothing else suppresses. */
export function sentFpsOnBranch(ctx: any): Set<string> {
  return new Set(sentEntriesOnBranch(ctx).filter((e: any) => e.data.kind === "delivered").map((e: any) => e.data.fp));
}
/** Actual hand-offs to Pi recorded on the current branch for this root fingerprint (rewound-away ones don't count). */
export function attemptsOnBranch(ctx: any, fp: string): number {
  return sentEntriesOnBranch(ctx).filter((e: any) => e.data.kind === "attempt" && e.data.fp === fp).length;
}
/**
 * Outstanding reminder slots, process-wide, keyed by SESSION id (a Pi process can switch sessions:
 * /new, /resume, fork). Written when a load hands a reminder to its helper, cleared on its commit/abandon.
 */
function openSlots(): Record<string, { fp: string; since: number; load: string }> {
  const g = globalThis as any;
  return (g.__wosOpenLoopSlots ??= {});
}
/** A slot for THIS session owned by a PREVIOUS load (same process, after /reload) and still outstanding. */
function previousLoadSlot(session: string, load: string): { state: string } | null {
  try {
    const v = openSlots()[session];
    if (!v || v.load === load) return null;
    return Date.now() - Number(v.since ?? 0) < PREV_SLOT_MAX_MS ? { state: "outstanding" } : null;
  } catch { return null; }
}

// ── actuator coordination ─────────────────────────────────────────────────────────────────
// "At most one injection per turn" across ALL agent_settled guards: wos-guards.ts stamps
// globalThis.__wosSettledInjection when it injects. This guard decides after a macrotask, so the
// other guards' handlers have already run regardless of extension load order.
function otherGuardInjected(sinceMs: number): boolean {
  try {
    const g = (globalThis as any).__wosSettledInjection;
    return !!g && Number(g.at ?? 0) >= sinceMs;
  } catch {
    return false;
  }
}
function stampInjection() {
  try { (globalThis as any).__wosSettledInjection = { at: Date.now(), by: "open-loop" }; } catch { /* */ }
}

export let lastDecision: Promise<any> = Promise.resolve(null);

export default function (pi: any) {
  pi.on("session_start", (_event: any, ctx: any) => { noteRuntimeSession(ctx); return undefined; });
  // R8.8: no per-load fingerprint memory anywhere (the helper-unavailable fallback too): dedup = branch entries only.

  // ── settled-send durability (request 2026-09-26) ──────────────────────────
  // 🔴 Two doors lost the reminder. (1) lastFingerprint was committed BEFORE Pi accepted the message;
  // during a compaction Pi rejects prompts and sendUserMessage is fire-and-forget. (2) Measured on real
  // Pi 0.87.1: a settle INSIDE a compaction sees ctx.isIdle() === false (isIdle = !runActive &&
  // !isCompacting), the old `not-idle` exit returned, and nothing ever re-tried (open row written,
  // reminder lost). Now the reminder goes through the SHARED receipt-confirmed, single-flight sender
  // (~/.wos-runtime/pi_extensions/lib/settled-send.ts, settled-send-helper package B R8.3, the same
  // object wos-guards uses). The one-shot marker is written only on a BRANCH RECEIPT (the exact user entry
  // newly on the branch; message_end alone is not one — Pi runs extension message_end handlers before
  // appendMessage). The helper tracks issued → accepted (`input`) → started (`before_agent_start`) and
  // follows DIR-wos policy A — NO DUPLICATES, EVER: the only resend is a compaction drop proven by a
  // VERIFIED input witness (~/.wos-runtime/pi_extensions/witness/, loaded first via the project-local manifest
  // <WOS root>/.pi/extensions/000-wos-input-witness/package.json; self-checked on every input relayed below,
  // including that it saw the SAME dispatch ctx — so relay the handler's own ctx, never a cached one); only a
  // compaction that RAN counts; a send that reached input but got no receipt is ABANDONED (`lost-after-input`, visible
  // gate row), never resent. Never on elapsed time, a bare settle, or run attribution. WOS owners are
  // serialized (bounded hold). At most 2 sends; waiting is
  // bounded (10 min) and logged. A busy send waits and is sent once idle. While one is pending no new
  // reminder fires; stale/partially-closed reminders are superseded/rebuilt (sendReminder).
  // The helper is loaded lazily, so this factory relays input/before_agent_start itself
  // (registerHandlers:false) from synchronous handlers, plus every lifecycle wake.
  let settledSender: any = null;
  // ── one-shot state = the CURRENT BRANCH, nothing in memory (open-loop-r8-verify, R8.3/R8.4) ──
  // 🔴 A fresh factory (after /reload) had no memory and re-sent the identical reminder; and a same-load
  // branch rewind was blocked by memory. Dedup now comes ONLY from (a) durable custom entries
  // `wos-open-loop-sent {fp, kind}` on the current branch (pi.appendEntry — durable, never LLM context)
  // and (b) the outstanding slot (ours, or the PREVIOUS load's for this session, adopted after /reload).
  // 🔴 The suppressing marker (`delivered`) is written ONLY at RECEIPT (the helper's commit: our exact user
  // entry newly on the branch), never at issue or abandon: an issued send can still be dropped, and a
  // restart would then read the marker and LOSE the reminder. DIR-wos ruling: loss is worse than a bounded
  // duplicate (at most MAX_ATTEMPTS hand-offs per root fp on a branch).
  // 🔴 R8.6 (open-loop-r8-verify loss class; DIR-wos ruling replaces the R8.5 rule): the helper calls `stamp`
  // BEFORE pi.sendUserMessage, so a stamp-derived "issued" flag counted a THROWN send as issued, and any
  // `abandoned` marker suppressed a reminder that never arrived (throw, or an unwitnessed compaction drop).
  // Now: NO suppressing marker except `delivered`. The helper gets a thin pi view whose sendUserMessage records
  // a non-suppressing `attempt` entry only AFTER the real sendUserMessage RETURNED (a throw = no attempt).
  // Abandon and the kill switch write nothing. Re-offer stops at MAX_ATTEMPTS attempts on the branch.
  const LOAD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; // this factory run
  let onHanded: null | (() => void) = null; // the current slot's "handed to Pi" recorder (set by sendReminder)
  const recordDurable = (fp: string, kind: string, extra: Record<string, unknown> = {}) => {
    try { pi.appendEntry?.(SENT_ENTRY_TYPE, { v: 3, fp, kind, ...extra, at: new Date().toISOString() }); }
    catch (e) { logGate(`appendEntry failed: ${String(e).slice(0, 120)}`, "open-loop-settled-send-durable-write-failed"); }
  };
  const piForHelper = {
    on: (...a: any[]) => pi.on(...a),
    sendUserMessage: (text: any, opts: any) => {
      pi.sendUserMessage(text, opts); // throws → propagates to the helper; no attempt is recorded
      onHanded?.();                   // returned: the reminder was actually handed to Pi
    },
  };
  const exhaustedLogged = new Set<string>(); // log de-dup only; never a veto
  const backstopLogged = new Set<string>();  // log de-dup only (once per window); never a veto
  const backstopHit = (c: any, session: string): boolean => {
    const w = backstopWindow(c);
    if (w.n < BACKSTOP_MAX) return false;
    const k = `${session}|${w.since}`;
    if (!backstopLogged.has(k)) { backstopLogged.add(k); logGate(`${w.n} hand-offs since the last user message (${w.since})`, "open-loop-settled-send-backstop-exhausted"); }
    return true;
  };
  const SETTLED_SEND_LIB = process.env.WOS_SETTLED_SEND_LIB ??
    path.join(os.homedir(), ".wos-runtime", "pi_extensions", "lib", "settled-send.ts");
  const knob = (k: string) => Number(process.env[k] ?? "") || undefined; // test knobs only
  const settledSendLib: Promise<any> = import(SETTLED_SEND_LIB).then((lib: any) => {
    const t = { compactionGraceMs: knob("WOS_OPEN_LOOP_COMPACTION_GRACE_MS"), lostAfterMs: knob("WOS_OPEN_LOOP_LOST_AFTER_MS"),
      acceptedLostAfterMs: knob("WOS_OPEN_LOOP_ACCEPTED_LOST_AFTER_MS"), holdMs: knob("WOS_OPEN_LOOP_HOLD_MS"),
      recheckMs: knob("WOS_OPEN_LOOP_RECHECK_MS"), maxWaitMs: knob("WOS_OPEN_LOOP_MAX_WAIT_MS") };
    settledSender = lib.createSettledSender(piForHelper, {
      owner: "open-loop",
      registerHandlers: false, // relayed below
      log: (klass: string, detail: string) => logGate(detail, klass),
      stamp: () => { stampInjection(); }, // fires just BEFORE sendUserMessage: never evidence of a hand-off
      ...Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined)),
    });
    return lib;
  }).catch((err: any) => {
    logGate(String(err?.message ?? err).slice(0, 200), "open-loop-settled-send-lib-unavailable");
    return null;
  });
  void settledSendLib;
  let lastCtx: any = null; // freshest ctx, for a reminder rebuilt inside the helper's abandon()
  // agent_start / agent_end are relayed ALWAYS (pending or not): the helper's loop accounting tells a real
  // run end from Pi's FALSE agent_settled (settled-send-helper R6/R7).
  for (const ev of ["message_end", "session_before_compact", "session_compact", "session_compact_failed", "turn_end", "agent_start", "agent_end"]) {
    pi.on(ev, (event: any, ctx: any) => {
      if (ev === "message_end" && event?.message?.role !== "user") return undefined;
      if (settledSender?.pending()) lastCtx = ctx;
      settledSender?.wake(ctx, ev);
      return undefined; // never cancels or supplies a compaction
    });
  }
  // EVERY input is relayed (not only ours) with THIS handler's ctx: it drives the witness self-check.
  pi.on("input", (e: any, ctx: any) => { settledSender?.onInput(e, ctx); return undefined; });
  pi.on("before_agent_start", (e: any, ctx: any) => { settledSender?.onBeforeAgentStart(e, ctx); return undefined; });
  const renderReminder = (rows: any[], session: string) =>
    `${OPEN_LOOP_PREFIX} Your final message leaves ${rows.length} open loop(s) that are not executed, dispatched, scheduled, or recorded as the owner-owned/blocked:\n` +
    renderRows(rows) +
    `\nIf it is reversible and inside the authority envelope, run it NOW and report the RESULT (it may change the headline). Otherwise dispatch it (name the child) or schedule it (job id). Only if it truly needs the owner or is blocked: ${RESOLVE_HINT(session)}. Do not restate the plan.`;
  /**
   * Receipt-confirmed reminder through the shared helper. The helper's payload is immutable and it
   * calls stillWanted() before every (re)send, so a PARTIAL closure while the reminder is unsent or was
   * rejected (H1 closed, H7 still open) makes stillWanted() false → the helper
   * abandons the stale text, and abandon() enqueues a FRESH reminder built from the rows still open
   * (a new slot, its own 4-send bound). Full closure → nothing is sent. Each rebuild strictly shrinks
   * the row set, so rebuilds are bounded by the row count.
   * 🔴 One-shot state is the ROOT fingerprint (the settle's fp). A rebuilt reminder records its durable marker
   * with rootFp, never its subset fp: otherwise a later settle on the unchanged final would find no marker
   * for its fp and re-fire the full stale reminder with a fresh send budget (V4b/V4c/V4e).
   */
  const sendReminder = (ctx: any, rows: any[], session: string, finalTail: string, rebuilt = false, rootFp = ""): string => {
    const ids = rows.map((r) => r.id);
    const fp = rootFp || loopKey(session, rows); // the LOOP key (never the final text)
    const msg = renderReminder(rows, session);
    let rebuild: any[] | null = null;
    const handed = () => { recordDurable(fp, "attempt", { n: attemptsOnBranch(lastCtx ?? ctx, fp) + 1 }); }; // root fp
    onHanded = handed; // set BEFORE send(): the helper may issue synchronously inside it
    lastCtx = ctx;
    const slots = openSlots();
    slots[session] = { fp, since: Date.now(), load: LOAD_ID };
    const release = () => { if (slots[session]?.fp === fp && slots[session]?.load === LOAD_ID) delete slots[session]; };
    logGate(rows.map((r) => r.text).join(" | "), rebuilt ? "open-loop-settled-send-rebuilt" : "open-loop-continuation");
    settledSender.send(ctx, "open-loop", msg, {
      commit: () => { if (onHanded === handed) onHanded = null; recordDurable(fp, "delivered"); release(); }, // RECEIPT (rebuilt: the root fp)
      abandon: () => {
        if (onHanded === handed) onHanded = null;
        // NOT delivered: write NOTHING (the attempt entries already bound re-offers)
        release();
        const r = rebuild; rebuild = null;
        if (r && r.length) {
          const c = lastCtx ?? ctx;
          if (sentFpsOnBranch(c).has(fp) || attemptsOnBranch(c, fp) >= MAX_ATTEMPTS) {
            logGate(`rebuild skipped :: ${r.map((x) => x.id).join(",")}`, "open-loop-settled-send-attempts-exhausted");
          } else if (!backstopHit(c, session)) sendReminder(c, r, session, finalTail, true, fp);
        }
      },
      stillWanted: () => {
        // 🔴 A kill switch engaged AFTER the reminder was deferred wins: the helper asks before every
        // (re)send, so a deferred/rejected reminder is abandoned, never rebuilt (open-loop-r6-verify).
        if (disabled()) { rebuild = null; logGate(`kill switch engaged while pending :: ${ids.join(",")}`, "open-loop-settled-send-killed"); return false; }
        // R8.8 backstop also gates the helper's own (re)send: it asks before every issue after the first.
        if (backstopHit(lastCtx ?? ctx, session)) { rebuild = null; return false; }
        const live = new Set(openRows(session).map((x: any) => x.id));
        const still = rows.filter((x) => live.has(x.id));
        if (still.length === rows.length) return true;
        rebuild = still; // [] on full closure → superseded, nothing sent
        return false;
      },
    });
    return msg;
  };

  pi.on("agent_settled", async (_event: any, ctx: any) => {
    // Relay EVERY settle to the helper FIRST — before the kill-switch check, the pending check and any
    // early return (mid-flight / no-assistant). Its loop accounting (quiescence) and the false-settle
    // rejection signal depend on seeing every settle (settled-send-helper R7). Its step runs on a timer,
    // after this handler's ledger writes.
    if (settledSender?.pending()) lastCtx = ctx;
    settledSender?.wake(ctx, "agent_settled");
    if (disabled()) return;
    const settledAt = Date.now();
    let resolveDecision: (v: any) => void = () => {};
    lastDecision = new Promise((r) => (resolveDecision = r));
    try {
      const branch = branchOf(ctx);
      const assistant = [...branch].reverse().find((m: any) => m?.role === "assistant");
      if (!assistant) return resolveDecision({ fired: false, reason: "no-assistant" });
      const blocks = Array.isArray(assistant.content) ? assistant.content : [];
      if (blocks.some((b: any) => b?.type === "toolCall" || b?.type === "tool_use")) {
        return resolveDecision({ fired: false, reason: "mid-flight" });
      }
      const finalText = textOf(assistant.content);
      const lastUser = [...branch].reverse().find((m: any) => m?.role === "user");
      const lastUserText = textOf(lastUser?.content);
      // Start of this turn (last REAL user message): a dispatch sent earlier in the SAME turn that
      // opened a loop is not "older than the loop" — open_loops.py verifies against this floor.
      const realUser = [...branch].reverse().find((m: any) => m?.role === "user" && !isInjected(textOf(m?.content)));
      const turnStartMs = Number(realUser?.timestamp ?? 0) || 0;
      const session = sessionIdOf(ctx);
      const receipts = receiptsOf(branch);
      const now = Date.now();

      // 1. close existing open rows this turn resolved
      const existing = openRows(session, now);
      const closed = resolveExisting(existing, finalText, receipts);
      appendRows(session, closed.map((c) => ({
        ts: new Date(now).toISOString(), ts_ms: now, session, id: c.row.id, event: "resolved", status: c.status,
        key: c.row.key, text: c.row.text, evidence: c.evidence,
      })));
      const closedIds = new Set(closed.map((c) => c.row.id));
      const stillOpenIds = new Set(existing.filter((r) => !closedIds.has(r.id)).map((r) => r.id));

      // 2. new hits from this turn
      const hits = analyzeTurn(finalText, receipts, { scanFiles: process.env.WOS_OPEN_LOOP_SCAN_FILES !== "0" });
      const rows: any[] = [];
      const openNow: any[] = [];
      for (const h of hits) {
        const id = rowId(session, h);
        const ev = h.status === "open" ? "open" : "resolved";
        if (ev === "open" && stillOpenIds.has(id)) { openNow.push({ id, ...h }); continue; } // no duplicate open row
        const row: any = { ts: new Date(now).toISOString(), ts_ms: now, session, id, event: ev, status: h.status,
          key: h.key, text: h.text, evidence: h.evidence, source: h.source };
        if (turnStartMs && turnStartMs <= now) row.turn_start_ms = turnStartMs;
        rows.push(row);
        if (ev === "open") openNow.push(row);
      }
      appendRows(session, rows);

      // 2b. a reminder is still pending (woken above): fire no new reminder.
      if (settledSender?.pending()) return resolveDecision({ fired: false, reason: "pending", hits });

      // 3. actuator — once per turn, never chained off its own injection
      if (!openNow.length) return resolveDecision({ fired: false, reason: "resolved", hits });
      if (String(lastUserText).trimStart().startsWith(OPEN_LOOP_PREFIX)) {
        return resolveDecision({ fired: false, reason: "already-injected-this-turn", hits });
      }
      const fp = loopKey(session, openNow); // R8.7/R8.8: keyed on the loop (keyless rows: their class), never the text
      // Durable one-shot (survives /reload + restart; follows branch rewinds): DELIVERED only suppresses.
      if (sentFpsOnBranch(ctx).has(fp)) return resolveDecision({ fired: false, reason: "already-sent-durable", hits });
      // Bounded give-up: MAX_ATTEMPTS actual hand-offs on this branch without a receipt → stop re-offering (logged).
      if (attemptsOnBranch(ctx, fp) >= MAX_ATTEMPTS) {
        if (!exhaustedLogged.has(fp)) { exhaustedLogged.add(fp); logGate(`${MAX_ATTEMPTS} attempts, no receipt :: ${openNow.map((r) => r.id).join(",")}`, "open-loop-settled-send-attempts-exhausted"); }
        return resolveDecision({ fired: false, reason: "attempts-exhausted", hits });
      }
      // R8.8 backstop: at most BACKSTOP_MAX hand-offs since the last real user message, whatever the keys.
      if (backstopHit(ctx, session)) return resolveDecision({ fired: false, reason: "backstop-exhausted", hits });
      // A slot of the PREVIOUS load (same process, after /reload) is still outstanding: adopt it — no new send.
      const prev = previousLoadSlot(session, LOAD_ID);
      if (prev) return resolveDecision({ fired: false, reason: `adopted-previous-load-slot:${prev.state}`, hits });

      setTimeout(async () => {
        try {
          // A settle before the helper's lazy import resolved must not take the lossy fallback.
          if (!settledSender) await settledSendLib;
          if (otherGuardInjected(settledAt)) return resolveDecision({ fired: false, reason: "other-guard-injected", hits });
          if (settledSender) {
            // Receipt-confirmed: one-shot state commits on the branch receipt, not here.
            const msg = sendReminder(ctx, openNow, session, finalText.slice(-200));
            return resolveDecision({ fired: true, reason: "open", hits, message: msg });
          }
          const msg = renderReminder(openNow, session);
          // Fallback (shared helper failed to load; logged). R8.8: the same durable dedup as the helper path — the
          // branch checks above (delivered / cap / backstop) plus an `attempt` entry AFTER sendUserMessage returns.
          if (typeof ctx?.isIdle === "function" && ctx.isIdle() === false) {
            return resolveDecision({ fired: false, reason: "not-idle", hits });
          }
          stampInjection();
          logGate(openNow.map((r) => r.text).join(" | "));
          pi.sendUserMessage(msg);                                                       // throws → no attempt
          recordDurable(fp, "attempt", { n: attemptsOnBranch(ctx, fp) + 1, fallback: true }); // returned: handed to Pi
          resolveDecision({ fired: true, reason: "open", hits, message: msg });
        } catch (e) {
          resolveDecision({ fired: false, reason: "error:" + String(e) });
        }
      }, Number(process.env.WOS_OPEN_LOOP_DEFER_MS ?? 25));
    } catch (e) {
      resolveDecision({ fired: false, reason: "error:" + String(e) });
    }
  });

  // F2/F3: surface open rows on every LLM call while they exist (recomputed from the ledger), at a FIXED,
  // cache-stable position with fixed bytes (placeTail; request 2026-09-26 FIX 4).
  pi.on("context", async (event: any, ctx: any) => {
    if (disabled()) return;
    try {
      const session = sessionIdOf(ctx);
      const rows = openRows(session);
      const all = event?.messages ?? [];
      const out = placeTail(all, rows, session);
      if (!rows.length && out.length === all.length) return undefined;
      return { messages: out };
    } catch {
      return;
    }
  });

  // Compaction output: persist one copy of the open rows into the post-compaction transcript.
  pi.on("session_compact", async (_event: any, ctx: any) => {
    if (disabled()) return;
    try {
      const session = sessionIdOf(ctx);
      const rows = openRows(session);
      if (!rows.length) return;
      pi.sendMessage({
        customType: CONTEXT_TYPE + "-compaction",
        content: `Open loops carried across compaction (open-loop ledger ${ledgerPath(session)}):\n${renderRows(rows)}`,
        display: false,
      }, { deliverAs: "nextTurn" });
    } catch { /* fail-open */ }
  });
}

export const __openLoop = {
  stripQuoted, sentences, keyTokens, resolveHit, analyzeTurn, openRows, readLedger, ledgerPath,
  addressedTo, outboundPaths, outboundBodies, outboundReason, heredocWrites, isCarried, stripOutboundParas, rowId,
  resolveExisting, contextTail, placeTail, sentFpsOnBranch, attemptsOnBranch, loopKey, loopClass, detectorOf, anchorOf, backstopWindow, BACKSTOP_MAX, MAX_ATTEMPTS, SENT_ENTRY_TYPE, receiptsOf, disabled, OPEN_LOOP_PREFIX, CONTEXT_TYPE,
  MARKER_EN, MARKER_ZH,
};
