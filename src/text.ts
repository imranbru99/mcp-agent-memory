import { createHash, randomBytes } from "node:crypto";

import { MemoryRejectedError, type MemoryScope, type MemoryType } from "./types.js";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "to", "of", "in", "on", "for", "with",
  "at", "by", "from", "as", "is", "are", "was", "were", "be", "been", "being", "it", "its", "this",
  "that", "these", "those", "we", "i", "you", "our", "your", "their", "they", "them", "my", "me",
  "do", "does", "did", "not", "no", "yes", "so", "than", "too", "very", "just", "about", "into",
  "over", "after", "before", "when", "what", "which", "who", "how", "use", "using", "used",
  "always", "never", "should", "would", "could", "please", "have", "has", "had", "will", "can",
  "must", "also", "only", "each", "other", "such", "same", "because", "while", "where", "there",
  "here", "want", "need", "needs", "keep", "within", "without", "across", "per", "via",
]);

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];

const TYPE_CUES: { type: MemoryType; pattern: RegExp }[] = [
  { type: "preference", pattern: /\b(prefer\w*|i like|i want|please always|please never|rather than)\b/i },
  { type: "decision", pattern: /\b(decisions?|decid(?:e|ed|ing)|we chose|we'll use|we will use|going with|trade-?off|chose)\b/i },
  { type: "convention", pattern: /\b(conventions?|style guide|naming|in this (?:repo|project|codebase)|always use|pattern)\b/i },
  { type: "note", pattern: /\b(todo|note:|fyi|remember that|follow up)\b/i },
];

const DEFAULT_IMPORTANCE: Record<MemoryType, number> = {
  decision: 4,
  convention: 4,
  preference: 4,
  fact: 3,
  note: 2,
};

export function createMemoryId(now = Date.now()): string {
  const time = Math.floor(now / 1000).toString(16).padStart(8, "0");
  return `mem_${time}${randomBytes(4).toString("hex")}`;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function contentHash(input: {
  scope: MemoryScope;
  project: string | null;
  type: MemoryType;
  content: string;
}): string {
  const normalized = normalizeWhitespace(input.content).toLowerCase();
  return createHash("sha256")
    .update([input.scope, input.project ?? "", input.type, normalized].join("\0"))
    .digest("hex");
}

export function assertNoSecrets(content: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content)) || hasAssignedSecret(content)) {
    throw new MemoryRejectedError(
      "Refusing to store this memory because it looks like a secret (key, token, or password). Save a reference such as \"API key lives in .env\" instead of the secret itself.",
    );
  }
}

function hasAssignedSecret(content: string): boolean {
  const match = content.match(
    /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|token)\s*[:=]\s*['"]?([A-Za-z0-9_./+=-]{8,})/i,
  );
  const value = match?.[1];
  if (!value) return false;
  const mixed = /[0-9]/.test(value) && /[A-Za-z]/.test(value);
  return mixed || value.length >= 20;
}

export function normalizeContent(content: string): string {
  const clean = content.replace(/\r\n/g, "\n").trim();
  if (!clean) throw new MemoryRejectedError("Memory content is empty.");
  if (clean.length > 16_000) {
    throw new MemoryRejectedError("Memory is too long (16000 character max). Split it, or save a short summary of it.");
  }
  assertNoSecrets(clean);
  return clean;
}

export function inferType(content: string): MemoryType {
  for (const cue of TYPE_CUES) {
    if (cue.pattern.test(content)) return cue.type;
  }
  return "fact";
}

export function defaultImportance(type: MemoryType): number {
  return DEFAULT_IMPORTANCE[type];
}

export function titleFromContent(content: string): string {
  const line = content.split(/\r?\n/).find((part) => part.trim().length > 0) ?? content;
  const sentence = line.split(/(?<=[.!?])\s/)[0] ?? line;
  return truncate(normalizeWhitespace(sentence), 120);
}

export function summarize(content: string): string | null {
  const clean = content.trim();
  if (clean.length <= 320) return null;
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let summary = "";
  for (const sentence of sentences) {
    if (summary.length >= 220) break;
    summary = summary.length === 0 ? sentence : `${summary} ${sentence}`;
  }
  if (summary.length < 80) summary = clean.slice(0, 280);
  return truncate(normalizeWhitespace(summary), 280);
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function normalizeTag(raw: string): string | null {
  const tag = raw
    .trim()
    .toLowerCase()
    .replace(/[:_/\s]+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (tag.length < 2 || tag.length > 32) return null;
  return tag;
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= 12) break;
  }
  return result;
}

export function autoTags(content: string, title: string): string[] {
  const source = `${title}\n${content}`;
  const tags: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const tag = normalizeTag(raw);
    if (!tag || seen.has(tag) || STOPWORDS.has(tag)) return;
    seen.add(tag);
    tags.push(tag);
  };

  for (const match of source.matchAll(/#([A-Za-z][\w-]{1,31})/g)) add(match[1] ?? "");
  for (const match of source.matchAll(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b/g)) add(match[0] ?? "");
  for (const match of source.matchAll(/\b[A-Za-z][\w.-]*\.[\w.-]+\b/g)) add(match[0] ?? "");
  for (const match of source.matchAll(/\b[A-Za-z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9]+\b/g)) add(match[0] ?? "");
  for (const match of source.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]+\b/g)) add(match[0] ?? "");

  const counts = new Map<string, number>();
  for (const token of tokenize(source)) {
    if (token.length < 4 || STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0]));
  for (const [token] of ranked) {
    if (tags.length >= 6) break;
    add(token);
  }
  return tags.slice(0, 6);
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function toFtsQuery(value: string): string | null {
  const tokens = [...new Set(tokenize(value))].slice(0, 16);
  if (tokens.length === 0) return null;
  return tokens
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" OR ");
}

export function previewText(content: string, summary: string | null, max = 280): string {
  return truncate(normalizeWhitespace(summary ?? content), max);
}

export function normalizeProject(project: string): string {
  const clean = project.trim();
  if (!/^[\w ./-]{1,80}$/.test(clean) || clean.includes("..")) {
    throw new MemoryRejectedError(
      "Project names must be 1-80 characters of letters, numbers, spaces, dots, underscores, slashes, or hyphens.",
    );
  }
  return clean;
}

export function assertImportance(importance: number): void {
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new MemoryRejectedError("Importance must be an integer from 1 (minor) to 5 (always apply).");
  }
}
