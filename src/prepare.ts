import type { EmbeddingProvider } from "./embedding.js";
import {
  assertImportance,
  autoTags,
  contentHash,
  defaultImportance,
  inferType,
  normalizeContent,
  normalizeProject,
  normalizeTags,
  normalizeWhitespace,
  summarize,
  titleFromContent,
} from "./text.js";
import {
  MemoryRejectedError,
  type Memory,
  type MemoryFilter,
  type MemoryPatch,
  type MemoryScope,
  type MemoryType,
  type NewMemory,
} from "./types.js";

export type EmbeddingStatus = "off" | "stored" | "unavailable";

export interface AddInput {
  content: string;
  title?: string;
  type?: MemoryType;
  category?: string | null;
  importance?: number;
  tags?: string[];
  scope?: MemoryScope;
  project?: string;
  source?: string | null;
}

export interface UpdateInput {
  title?: string;
  content?: string;
  type?: MemoryType;
  category?: string | null;
  importance?: number;
  tags?: string[];
  scope?: MemoryScope;
  project?: string | null;
  source?: string | null;
}

export interface Placement {
  scope: MemoryScope;
  project: string | null;
}

export async function prepareAdd(
  input: AddInput,
  deps: { defaultProject: string | null; embedder: EmbeddingProvider },
): Promise<{ memory: NewMemory; embeddingStatus: EmbeddingStatus }> {
  const content = normalizeContent(input.content);
  const type = input.type ?? inferType(content);
  const placement = resolvePlacement(input, deps.defaultProject);
  const title = input.title ? normalizeTitle(input.title) : titleFromContent(content);
  const tags = input.tags ? requireTags(input.tags) : autoTags(content, title);
  const importance = input.importance ?? defaultImportance(type);
  assertImportance(importance);
  const category = normalizeOptionalLabel(input.category, "Category", 40);
  const source = normalizeOptionalLabel(input.source, "Source", 160);
  const draft = {
    title,
    content,
    summary: summarize(content),
    type,
    category: category ?? null,
    importance,
    scope: placement.scope,
    project: placement.project,
    source: source ?? null,
    tags,
    contentHash: contentHash({ scope: placement.scope, project: placement.project, type, content }),
  };
  const embedded = await embedDraft(draft, deps.embedder);
  return {
    memory: { ...draft, embedding: embedded.vector, embeddingModel: embedded.model },
    embeddingStatus: embedded.status,
  };
}

export async function prepareUpdate(
  existing: Memory,
  input: UpdateInput,
  deps: { defaultProject: string | null; embedder: EmbeddingProvider },
): Promise<{ patch: MemoryPatch; embeddingStatus: EmbeddingStatus | "unchanged" }> {
  const content = input.content === undefined ? existing.content : normalizeContent(input.content);
  const type = input.type ?? existing.type;
  const placement = placementForUpdate(existing, input, deps.defaultProject);
  const title = input.title === undefined ? existing.title : normalizeTitle(input.title);
  const tags = input.tags === undefined ? existing.tags : requireTags(input.tags);
  const importance = input.importance ?? existing.importance;
  assertImportance(importance);
  const category = input.category === undefined ? existing.category : normalizeOptionalLabel(input.category, "Category", 40) ?? null;
  const source = input.source === undefined ? existing.source : normalizeOptionalLabel(input.source, "Source", 160) ?? null;
  const patch: MemoryPatch = {
    title,
    content,
    summary: summarize(content),
    type,
    category,
    importance,
    scope: placement.scope,
    project: placement.project,
    source,
    tags,
    contentHash: contentHash({ scope: placement.scope, project: placement.project, type, content }),
  };

  const textChanged = content !== existing.content || title !== existing.title || tags.join("\0") !== existing.tags.join("\0");
  if (!textChanged) return { patch, embeddingStatus: "unchanged" };
  const embedded = await embedDraft({ title, content, tags }, deps.embedder);
  patch.embedding = embedded.vector;
  patch.embeddingModel = embedded.model;
  return { patch, embeddingStatus: embedded.status };
}

function placementForUpdate(existing: Memory, input: UpdateInput, defaultProject: string | null): Placement {
  if (input.scope === "global") {
    if (input.project) {
      throw new MemoryRejectedError("Global memories cannot set a project. Omit project, or use scope \"project\".");
    }
    return { scope: "global", project: null };
  }
  if (input.scope === "project") {
    const project = input.project
      ? normalizeProject(input.project)
      : existing.project ?? (defaultProject ? normalizeProject(defaultProject) : null);
    if (!project) {
      throw new MemoryRejectedError("Project scope needs a project name. Pass project, or set AGENT_MEMORY_PROJECT.");
    }
    return { scope: "project", project };
  }
  if (input.project) return { scope: "project", project: normalizeProject(input.project) };
  return { scope: existing.scope, project: existing.project };
}

export function resolveReadFilter(
  input: {
    type?: MemoryType;
    category?: string;
    tags?: string[];
    minImportance?: number;
    scope?: MemoryScope;
    project?: string;
    includeGlobal?: boolean;
  },
  defaultProject: string | null,
): MemoryFilter {
  const filter: MemoryFilter = {};
  if (input.type) filter.type = input.type;
  const category = input.category ? normalizeWhitespace(input.category) : "";
  if (category) filter.category = category;
  if (input.tags && input.tags.length > 0) {
    const tags = requireTags(input.tags);
    if (tags.length > 0) filter.tags = tags;
  }
  if (input.minImportance !== undefined) {
    assertImportance(input.minImportance);
    filter.minImportance = input.minImportance;
  }
  if (input.scope === "global") {
    if (input.project) throw new MemoryRejectedError("A global filter cannot also set a project.");
    filter.scope = "global";
    return filter;
  }
  if (input.scope === "project") {
    const project = input.project ? normalizeProject(input.project) : defaultProject ? normalizeProject(defaultProject) : null;
    if (!project) throw new MemoryRejectedError("Project scope needs a project name. Pass project, or set AGENT_MEMORY_PROJECT.");
    filter.scope = "project";
    filter.project = project;
    return filter;
  }
  const project = input.project ? normalizeProject(input.project) : defaultProject ? normalizeProject(defaultProject) : null;
  if (!project) return filter;
  filter.project = project;
  filter.includeGlobal = input.includeGlobal ?? true;
  return filter;
}

export function resolvePlacement(input: { scope?: MemoryScope; project?: string | null }, defaultProject: string | null): Placement {
  if (input.scope === "global") {
    if (input.project) {
      throw new MemoryRejectedError("Global memories cannot set a project. Omit project, or use scope \"project\".");
    }
    return { scope: "global", project: null };
  }

  const project = input.project ? normalizeProject(input.project) : defaultProject ? normalizeProject(defaultProject) : null;
  if (input.scope === "project" && !project) {
    throw new MemoryRejectedError("Project scope needs a project name. Pass project, or set AGENT_MEMORY_PROJECT.");
  }
  if (project) return { scope: "project", project };
  return { scope: "global", project: null };
}

async function embedDraft(
  draft: { title: string; content: string; tags: string[] },
  embedder: EmbeddingProvider,
): Promise<{ vector: Float32Array | null; model: string | null; status: EmbeddingStatus }> {
  if (embedder.id === "off") return { vector: null, model: null, status: "off" };
  const vector = await embedder.embed(`${draft.title}\n${draft.content}\n${draft.tags.join(" ")}`);
  if (!vector || norm(vector) === 0) return { vector: null, model: null, status: "unavailable" };
  return { vector, model: embedder.id, status: "stored" };
}

function norm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function normalizeTitle(title: string): string {
  const clean = normalizeWhitespace(title);
  if (!clean) throw new MemoryRejectedError("Title is empty.");
  if (clean.length > 140) throw new MemoryRejectedError("Title must be 140 characters or fewer.");
  return clean;
}

function requireTags(tags: string[]): string[] {
  if (tags.length === 0) return [];
  const normalized = normalizeTags(tags);
  if (normalized.length === 0) {
    throw new MemoryRejectedError("None of the tags were usable. Use 2-32 character tags made of letters, numbers, and hyphens.");
  }
  return normalized;
}

function normalizeOptionalLabel(value: string | null | undefined, label: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const clean = normalizeWhitespace(value);
  if (!clean) return null;
  if (clean.length > max) throw new MemoryRejectedError(`${label} must be ${max} characters or fewer.`);
  return clean;
}
