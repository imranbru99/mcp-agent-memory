export const MEMORY_TYPES = ["fact", "preference", "decision", "convention", "note"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SCOPES = ["global", "project"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const SEARCH_MODES = ["hybrid", "keyword", "semantic"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export interface Memory {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  type: MemoryType;
  category: string | null;
  importance: number;
  scope: MemoryScope;
  project: string | null;
  source: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
}

export interface NewMemory {
  title: string;
  content: string;
  summary: string | null;
  type: MemoryType;
  category: string | null;
  importance: number;
  scope: MemoryScope;
  project: string | null;
  source: string | null;
  tags: string[];
  contentHash: string;
  embedding: Float32Array | null;
  embeddingModel: string | null;
}

export interface MemoryPatch {
  title?: string;
  content?: string;
  summary?: string | null;
  type?: MemoryType;
  category?: string | null;
  importance?: number;
  scope?: MemoryScope;
  project?: string | null;
  source?: string | null;
  tags?: string[];
  contentHash?: string;
  embedding?: Float32Array | null;
  embeddingModel?: string | null;
}

export interface MemoryFilter {
  type?: MemoryType;
  category?: string;
  tags?: string[];
  minImportance?: number;
  scope?: MemoryScope;
  project?: string;
  includeGlobal?: boolean;
}

export interface SearchHit {
  memory: Memory;
  score: number;
  keyword: number;
  semantic: number;
  snippet: string;
}

export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
  byScope: Record<MemoryScope, number>;
  projects: { project: string; count: number }[];
  fts: boolean;
  embeddingModel: string;
  databasePath: string;
}

export class MemoryNotFoundError extends Error {
  readonly code = "not_found";

  constructor(id: string) {
    super(`No memory with id ${id}.`);
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryConflictError extends Error {
  readonly code = "conflict";
  readonly existingId: string;

  constructor(existingId: string) {
    super(`A memory with the same content already exists (${existingId}). Update that memory instead of creating a duplicate.`);
    this.name = "MemoryConflictError";
    this.existingId = existingId;
  }
}

export class MemoryRejectedError extends Error {
  readonly code = "rejected";

  constructor(message: string) {
    super(message);
    this.name = "MemoryRejectedError";
  }
}
