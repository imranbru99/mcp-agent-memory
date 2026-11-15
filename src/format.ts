import { previewText, truncate } from "./text.js";
import type { Memory, MemoryFilter, SearchHit } from "./types.js";

export interface MemoryCard {
  id: string;
  title: string;
  preview: string;
  type: Memory["type"];
  category: string | null;
  importance: number;
  scope: Memory["scope"];
  project: string | null;
  tags: string[];
  updated_at: string;
}

export interface MemoryView extends MemoryCard {
  content: string;
  summary: string | null;
  source: string | null;
  created_at: string;
  last_accessed_at: string | null;
  access_count: number;
}

export function toView(memory: Memory): MemoryView {
  return {
    ...toCard(memory),
    content: memory.content,
    summary: memory.summary,
    source: memory.source,
    created_at: memory.createdAt,
    last_accessed_at: memory.lastAccessedAt,
    access_count: memory.accessCount,
  };
}

export function toCard(memory: Memory): MemoryCard {
  return {
    id: memory.id,
    title: memory.title,
    preview: previewText(memory.content, memory.summary),
    type: memory.type,
    category: memory.category,
    importance: memory.importance,
    scope: memory.scope,
    project: memory.project,
    tags: memory.tags,
    updated_at: memory.updatedAt,
  };
}

export function formatStored(memory: Memory, duplicate: boolean, embeddingStatus: string): string {
  const lead = duplicate ? `Kept existing memory ${memory.id} (identical content already stored).` : `Stored memory ${memory.id}.`;
  const lines = [lead, formatBrief(memory), "", memory.content];
  if (duplicate) lines.push("", "Tags were merged. Importance was raised when the new value was higher.");
  if (embeddingStatus === "unavailable") lines.push("", "Embedding was not saved. Keyword search still works.");
  return lines.join("\n");
}

export function formatDetail(memory: Memory): string {
  return [
    memory.id,
    `${memory.type} · importance ${memory.importance} · ${scopeLabel(memory)}`,
    `updated ${memory.updatedAt}`,
    memory.category ? `category: ${memory.category}` : "",
    memory.tags.length > 0 ? `tags: ${memory.tags.join(", ")}` : "",
    memory.source ? `source: ${memory.source}` : "",
    "",
    memory.title,
    "",
    memory.content,
  ].filter((line) => line !== "").join("\n");
}

export function formatList(memories: Memory[], total: number, scopeNote: string): string {
  if (memories.length === 0) return `No memories (${scopeNote}).`;
  const cards = memories.map((memory, index) => formatBrief(memory, index + 1)).join("\n\n");
  return `${memories.length} of ${total} memories (${scopeNote}).\n\n${cards}\n\nUse memory_get with an id for the full text.`;
}

export function formatSearch(query: string, hits: SearchHit[], scopeNote: string, mode: string, note?: string): string {
  const shown = truncate(query, 80);
  if (hits.length === 0) {
    const hint = note ?? "Try fewer words, or call memory_list to browse recent memories.";
    return `No memories matched "${shown}" (${scopeNote}, ${mode}). ${hint}`;
  }
  const cards = hits.map((hit, index) => `${formatBrief(hit.memory, index + 1)}\nscore ${hit.score.toFixed(2)}`).join("\n\n");
  const extra = note ? `\n\n${note}` : "";
  return `Found ${hits.length} memor${hits.length === 1 ? "y" : "ies"} for "${shown}" (${scopeNote}, ${mode}).\n\n${cards}${extra}\n\nUse memory_get with an id for the full text.`;
}

export function describeFilter(filter: MemoryFilter): string {
  const bits: string[] = [];
  if (filter.scope === "global") bits.push("global only");
  else if (filter.scope === "project") bits.push(`project ${filter.project ?? "?"}`);
  else if (filter.project && filter.includeGlobal === false) bits.push(`project ${filter.project}`);
  else if (filter.project) bits.push(`project ${filter.project} + global`);
  else bits.push("all projects");
  if (filter.type) bits.push(filter.type);
  if (filter.category) bits.push(`category ${filter.category}`);
  if (filter.tags && filter.tags.length > 0) bits.push(`tags ${filter.tags.join("+")}`);
  if (filter.minImportance) bits.push(`importance >= ${filter.minImportance}`);
  return bits.join(", ");
}

function formatBrief(memory: Memory, index?: number): string {
  const prefix = index === undefined ? memory.id : `${index}. ${memory.id}`;
  const tags = memory.tags.length > 0 ? `\ntags: ${memory.tags.join(", ")}` : "";
  const category = memory.category ? `\ncategory: ${memory.category}` : "";
  return `${prefix} · ${memory.type} · importance ${memory.importance} · ${scopeLabel(memory)} · ${memory.updatedAt.slice(0, 10)}\n${memory.title}${category}${tags}`;
}

function scopeLabel(memory: Memory): string {
  return memory.scope === "project" ? `project:${memory.project}` : "global";
}
