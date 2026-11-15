import { mkdirSync } from "node:fs";
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";
import { dirname } from "node:path";

import { cosine, decodeEmbedding, encodeEmbedding, type EmbeddingProvider } from "./embedding.js";
import { createLogger, silenceSqliteExperimentalWarning, type Logger } from "./log.js";
import { createMemoryId, normalizeTags, previewText, toFtsQuery, tokenize } from "./text.js";
import {
  MEMORY_TYPES,
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryRejectedError,
  type Memory,
  type MemoryFilter,
  type MemoryPatch,
  type MemoryScope,
  type MemoryStats,
  type MemoryType,
  type NewMemory,
  type SearchHit,
  type SearchMode,
} from "./types.js";

const COLUMNS = `id, title, content, summary, type, category, importance, scope, project, source, tags,
  content_hash, embedding_model, created_at, updated_at, last_accessed_at, access_count`;

export interface SearchResult {
  hits: SearchHit[];
  mode: SearchMode;
  note?: string;
}

export interface AddResult {
  memory: Memory;
  duplicate: boolean;
}

/**
 * Persistence port used by the MCP tools.
 * SQLite is the built-in backend. Another backend (hosted Postgres, sqlite-vec)
 * can implement this interface without changing the tools.
 */
export interface MemoryStore {
  add(memory: NewMemory): Promise<AddResult>;
  get(id: string, options?: { touch?: boolean }): Promise<Memory | null>;
  update(id: string, patch: MemoryPatch): Promise<Memory>;
  delete(id: string): Promise<boolean>;
  list(filter: MemoryFilter, options: { limit: number; offset: number; sort: "recent" | "importance" }): Promise<{ memories: Memory[]; total: number }>;
  search(query: string, filter: MemoryFilter, options: { limit: number; mode: SearchMode }): Promise<SearchResult>;
  count(filter: MemoryFilter): Promise<number>;
  clear(filter: MemoryFilter): Promise<number>;
  stats(): Promise<MemoryStats>;
  close(): void;
}

interface Stored extends Memory {
  contentHash: string;
  embeddingModel: string | null;
}

let fts5Available: boolean | null = null;

async function detectFts5(DatabaseSync: typeof import("node:sqlite").DatabaseSync): Promise<boolean> {
  if (fts5Available !== null) return fts5Available;
  const probe = new DatabaseSync(":memory:");
  try {
    probe.exec("CREATE VIRTUAL TABLE fts5_probe USING fts5(content, tokenize = 'porter unicode61')");
    probe.exec("INSERT INTO fts5_probe(content) VALUES ('probe')");
    fts5Available = true;
  } catch {
    fts5Available = false;
  } finally {
    probe.close();
  }
  return fts5Available;
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly insertStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly touchStmt: StatementSync;
  private readonly updateStmt: StatementSync;

  private constructor(
    private readonly db: DatabaseSync,
    readonly databasePath: string,
    private readonly fts: boolean,
    private readonly embedder: EmbeddingProvider,
    private readonly logger: Logger,
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO memories (
        id, title, content, summary, type, category, importance, scope, project, source, tags,
        content_hash, embedding, embedding_model, created_at, updated_at, last_accessed_at, access_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
    `);
    this.deleteStmt = db.prepare("DELETE FROM memories WHERE id = ?");
    this.touchStmt = db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?");
    this.updateStmt = db.prepare(`
      UPDATE memories SET
        title = ?, content = ?, summary = ?, type = ?, category = ?, importance = ?,
        scope = ?, project = ?, source = ?, tags = ?, content_hash = ?,
        embedding = CASE WHEN ? = 1 THEN ? ELSE embedding END,
        embedding_model = CASE WHEN ? = 1 THEN ? ELSE embedding_model END,
        updated_at = ?
      WHERE id = ?
    `);
  }

  static async open(options: { databasePath: string; embedder: EmbeddingProvider; logger?: Logger }): Promise<SqliteMemoryStore> {
    silenceSqliteExperimentalWarning();
    if (options.databasePath !== ":memory:") mkdirSync(dirname(options.databasePath), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const fts = await detectFts5(DatabaseSync);
    const db = new DatabaseSync(options.databasePath, { timeout: 5000 });
    applySchema(db, fts, options.databasePath);
    return new SqliteMemoryStore(db, options.databasePath, fts, options.embedder, options.logger ?? createLogger("error"));
  }

  async add(memory: NewMemory): Promise<AddResult> {
    const existing = this.findByHash(memory.contentHash);
    if (existing) return { memory: this.mergeDuplicate(existing, memory), duplicate: true };

    const id = createMemoryId();
    const timestamp = now();
    try {
      this.insertStmt.run(
        id,
        memory.title,
        memory.content,
        memory.summary,
        memory.type,
        memory.category,
        memory.importance,
        memory.scope,
        memory.project,
        memory.source,
        JSON.stringify(memory.tags),
        memory.contentHash,
        memory.embedding ? encodeEmbedding(memory.embedding) : null,
        memory.embeddingModel,
        timestamp,
        timestamp,
      );
    } catch (error) {
      if (!isConstraint(error)) throw error;
      const raced = this.findByHash(memory.contentHash);
      if (raced) return { memory: this.mergeDuplicate(raced, memory), duplicate: true };
      throw error;
    }
    return { memory: this.require(id), duplicate: false };
  }

  async get(id: string, options?: { touch?: boolean }): Promise<Memory | null> {
    const stored = this.findById(id);
    if (!stored) return null;
    if (options?.touch) {
      this.touchStmt.run(now(), id);
      return toMemory(this.findById(id) ?? stored);
    }
    return toMemory(stored);
  }

  async update(id: string, patch: MemoryPatch): Promise<Memory> {
    const existing = this.findById(id);
    if (!existing) throw new MemoryNotFoundError(id);
    const next = {
      title: patch.title ?? existing.title,
      content: patch.content ?? existing.content,
      summary: patch.summary === undefined ? existing.summary : patch.summary,
      type: patch.type ?? existing.type,
      category: patch.category === undefined ? existing.category : patch.category,
      importance: patch.importance ?? existing.importance,
      scope: patch.scope ?? existing.scope,
      project: patch.project === undefined ? existing.project : patch.project,
      source: patch.source === undefined ? existing.source : patch.source,
      tags: patch.tags ?? existing.tags,
      contentHash: patch.contentHash ?? existing.contentHash,
    };
    assertPlacement(next.scope, next.project);
    if (next.contentHash !== existing.contentHash) {
      const clash = this.findByHash(next.contentHash);
      if (clash && clash.id !== id) throw new MemoryConflictError(clash.id);
    }
    const replaceEmbedding = patch.embedding !== undefined || patch.embeddingModel !== undefined;
    this.updateStmt.run(
      next.title,
      next.content,
      next.summary,
      next.type,
      next.category,
      next.importance,
      next.scope,
      next.project,
      next.source,
      JSON.stringify(next.tags),
      next.contentHash,
      replaceEmbedding ? 1 : 0,
      replaceEmbedding ? (patch.embedding ? encodeEmbedding(patch.embedding) : null) : null,
      replaceEmbedding ? 1 : 0,
      replaceEmbedding ? (patch.embeddingModel ?? null) : null,
      now(),
      id,
    );
    return this.require(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.deleteStmt.run(id).changes > 0;
  }

  async list(filter: MemoryFilter, options: { limit: number; offset: number; sort: "recent" | "importance" }): Promise<{ memories: Memory[]; total: number }> {
    const where = this.where(filter);
    const total = scalar(this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where.sql}`).get(...where.params));
    const order = options.sort === "importance" ? "importance DESC, updated_at DESC" : "updated_at DESC";
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM memories WHERE ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...where.params, options.limit, options.offset);
    return { memories: rows.map((row) => toMemory(asStored(row))), total };
  }

  async search(query: string, filter: MemoryFilter, options: { limit: number; mode: SearchMode }): Promise<SearchResult> {
    let mode = options.mode;
    let note: string | undefined;
    const keywordRequested = mode !== "semantic";
    let keyword = keywordRequested ? this.keywordScores(query, filter) : new Map<string, number>();
    let semantic = new Map<string, number>();

    if (mode !== "keyword") {
      if (this.embedder.id === "off") {
        mode = "keyword";
        note = "Embeddings are off. Results are keyword only.";
      } else {
        const vector = await this.embedder.embed(query);
        if (!vector || vectorLength(vector) === 0) {
          mode = "keyword";
          note = "Semantic search is unavailable. Results are keyword only.";
        } else {
          semantic = this.semanticScores(vector, filter);
        }
      }
    }

    if (mode === "keyword" && !keywordRequested) keyword = this.keywordScores(query, filter);
    if (mode === "keyword") semantic = new Map();
    if (mode === "semantic") keyword = new Map();
    return this.rank(keyword, semantic, mode, note, options.limit);
  }

  async count(filter: MemoryFilter): Promise<number> {
    const where = this.where(filter);
    return scalar(this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where.sql}`).get(...where.params));
  }

  async clear(filter: MemoryFilter): Promise<number> {
    const where = this.where(filter);
    return Number(this.db.prepare(`DELETE FROM memories WHERE ${where.sql}`).run(...where.params).changes);
  }

  async stats(): Promise<MemoryStats> {
    const byType: Record<MemoryType, number> = { fact: 0, preference: 0, decision: 0, convention: 0, note: 0 };
    const byScope: Record<MemoryScope, number> = { global: 0, project: 0 };
    const projects = new Map<string, number>();
    let total = 0;
    for (const row of this.db.prepare("SELECT type, scope, project, COUNT(*) AS n FROM memories GROUP BY type, scope, project").all()) {
      const count = scalar(row);
      total += count;
      const type = String(row["type"]);
      if (isMemoryType(type)) byType[type] += count;
      const scope = String(row["scope"]);
      if (scope === "global" || scope === "project") byScope[scope] += count;
      if (scope === "project" && typeof row["project"] === "string") {
        projects.set(row["project"], (projects.get(row["project"]) ?? 0) + count);
      }
    }
    return {
      total,
      byType,
      byScope,
      projects: [...projects.entries()]
        .map(([project, count]) => ({ project, count }))
        .sort((left, right) => right.count - left.count || left.project.localeCompare(right.project)),
      fts: this.fts,
      embeddingModel: this.embedder.id,
      databasePath: this.databasePath,
    };
  }

  close(): void {
    this.db.close();
  }

  private mergeDuplicate(existing: Stored, incoming: NewMemory): Memory {
    const tags = normalizeTags([...existing.tags, ...incoming.tags]);
    const importance = Math.max(existing.importance, incoming.importance);
    const fillEmbedding = existing.embeddingModel === null && incoming.embedding !== null;
    const changed = tags.join("\0") !== existing.tags.join("\0") || importance !== existing.importance || fillEmbedding;
    if (changed) {
      this.db.prepare(`
        UPDATE memories SET
          tags = ?, importance = ?, updated_at = ?,
          embedding = CASE WHEN ? = 1 THEN ? ELSE embedding END,
          embedding_model = CASE WHEN ? = 1 THEN ? ELSE embedding_model END
        WHERE id = ?
      `).run(
        JSON.stringify(tags),
        importance,
        now(),
        fillEmbedding ? 1 : 0,
        fillEmbedding && incoming.embedding ? encodeEmbedding(incoming.embedding) : null,
        fillEmbedding ? 1 : 0,
        fillEmbedding ? incoming.embeddingModel : null,
        existing.id,
      );
    }
    return this.require(existing.id);
  }

  private keywordScores(query: string, filter: MemoryFilter): Map<string, number> {
    if (this.fts) {
      const scores = this.ftsScores(query, filter);
      if (scores) return scores;
    }
    return this.likeScores(query, filter);
  }

  private ftsScores(query: string, filter: MemoryFilter): Map<string, number> | null {
    const match = toFtsQuery(query);
    if (!match) return new Map();
    const where = this.where(filter, "m");
    try {
      const rows = this.db.prepare(`
        SELECT m.id AS id, bm25(memories_fts) AS rank
        FROM memories_fts
        JOIN memories m ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ? AND ${where.sql}
        ORDER BY rank
        LIMIT 80
      `).all(match, ...where.params);
      const scores = new Map<string, number>();
      for (const row of rows) {
        const rank = typeof row["rank"] === "number" ? row["rank"] : 0;
        scores.set(String(row["id"]), Math.max(0, -rank));
      }
      return scores;
    } catch (error) {
      this.logger.warn("full-text search failed; using a simple scan", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private likeScores(query: string, filter: MemoryFilter): Map<string, number> {
    const tokens = [...new Set(tokenize(query))].slice(0, 8);
    if (tokens.length === 0) return new Map();
    const where = this.where(filter);
    const tokenSql = tokens
      .map(() => "(lower(title) LIKE ? ESCAPE '\\' OR lower(content) LIKE ? ESCAPE '\\' OR lower(tags) LIKE ? ESCAPE '\\' OR lower(coalesce(summary, '')) LIKE ? ESCAPE '\\')")
      .join(" OR ");
    const params: SQLInputValue[] = [];
    for (const token of tokens) {
      const pattern = `%${escapeLike(token)}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    const rows = this.db.prepare(`SELECT id, title FROM memories WHERE (${tokenSql}) AND ${where.sql} LIMIT 80`).all(...params, ...where.params);
    const scores = new Map<string, number>();
    for (const row of rows) {
      const title = String(row["title"]).toLowerCase();
      const weight = tokens.reduce((sum, token) => sum + (title.includes(token) ? 2 : 1), 0);
      scores.set(String(row["id"]), weight);
    }
    return scores;
  }

  private semanticScores(query: Float32Array, filter: MemoryFilter): Map<string, number> {
    const where = this.where(filter);
    const rows = this.db.prepare(`
      SELECT id, embedding FROM memories
      WHERE embedding IS NOT NULL AND embedding_model = ? AND ${where.sql}
      ORDER BY updated_at DESC
      LIMIT 5000
    `).all(this.embedder.id, ...where.params);
    const scores = new Map<string, number>();
    for (const row of rows) {
      const blob = row["embedding"];
      if (!(blob instanceof Uint8Array)) continue;
      const similarity = cosine(query, decodeEmbedding(blob));
      if (similarity >= this.embedder.minCosine) scores.set(String(row["id"]), similarity);
    }
    return scores;
  }

  private rank(keyword: Map<string, number>, semantic: Map<string, number>, mode: SearchMode, note: string | undefined, limit: number): SearchResult {
    const ids = [...new Set([...keyword.keys(), ...semantic.keys()])];
    if (ids.length === 0) return { hits: [], mode, ...(note ? { note } : {}) };
    const memories = this.getMany(ids);
    const maxKeyword = Math.max(0, ...keyword.values());
    const hits: SearchHit[] = [];
    for (const memory of memories) {
      const keywordScore = maxKeyword > 0 ? (keyword.get(memory.id) ?? 0) / maxKeyword : 0;
      const semanticScore = semantic.get(memory.id) ?? 0;
      const relevance = mode === "keyword" ? keywordScore : mode === "semantic" ? semanticScore : 0.65 * keywordScore + 0.35 * semanticScore;
      if (relevance <= 0) continue;
      const ageMs = Math.max(0, Date.now() - Date.parse(memory.updatedAt));
      const recency = Math.exp(-ageMs / (30 * 24 * 60 * 60 * 1000));
      hits.push({
        memory,
        score: round3(relevance * 0.82 + (memory.importance / 5) * 0.12 + recency * 0.06),
        keyword: round3(keywordScore),
        semantic: round3(semanticScore),
        snippet: previewText(memory.content, memory.summary),
      });
    }
    hits.sort((left, right) => right.score - left.score || right.memory.importance - left.memory.importance || right.memory.updatedAt.localeCompare(left.memory.updatedAt));
    return { hits: hits.slice(0, limit), mode, ...(note ? { note } : {}) };
  }

  private getMany(ids: string[]): Memory[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(", ");
    return this.db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id IN (${marks})`).all(...ids).map((row) => toMemory(asStored(row)));
  }

  private findById(id: string): Stored | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`).get(id);
    return row ? asStored(row) : null;
  }

  private findByHash(hash: string): Stored | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM memories WHERE content_hash = ?`).get(hash);
    return row ? asStored(row) : null;
  }

  private require(id: string): Memory {
    const stored = this.findById(id);
    if (!stored) throw new MemoryNotFoundError(id);
    return toMemory(stored);
  }

  private where(filter: MemoryFilter, prefix = ""): { sql: string; params: SQLInputValue[] } {
    const col = (name: string) => (prefix ? `${prefix}.${name}` : name);
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.type) {
      clauses.push(`${col("type")} = ?`);
      params.push(filter.type);
    }
    if (filter.category) {
      clauses.push(`lower(${col("category")}) = lower(?)`);
      params.push(filter.category);
    }
    if (filter.minImportance !== undefined) {
      clauses.push(`${col("importance")} >= ?`);
      params.push(filter.minImportance);
    }
    if (filter.scope === "global") {
      clauses.push(`${col("scope")} = 'global'`);
    } else if (filter.scope === "project" || (filter.project && filter.includeGlobal === false)) {
      clauses.push(`${col("scope")} = 'project' AND ${col("project")} = ?`);
      params.push(filter.project ?? "");
    } else if (filter.project) {
      clauses.push(`((${col("scope")} = 'project' AND ${col("project")} = ?) OR ${col("scope")} = 'global')`);
      params.push(filter.project);
    }
    for (const tag of filter.tags ?? []) {
      clauses.push(`EXISTS (SELECT 1 FROM json_each(${col("tags")}) AS je WHERE je.value = ?)`);
      params.push(tag);
    }
    return { sql: clauses.length > 0 ? clauses.join(" AND ") : "1 = 1", params };
  }
}

function applySchema(db: DatabaseSync, fts: boolean, path: string): void {
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT
  `);
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (version && version["value"] !== "1") {
    throw new Error(`Unsupported agent-memory database schema version ${String(version["value"])}. This build expects version 1.`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      type TEXT NOT NULL CHECK (type IN ('fact', 'preference', 'decision', 'convention', 'note')),
      category TEXT,
      importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
      scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
      project TEXT,
      source TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      content_hash TEXT NOT NULL,
      embedding BLOB,
      embedding_model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      CHECK ((scope = 'global' AND project IS NULL) OR (scope = 'project' AND project IS NOT NULL))
    ) STRICT
  `);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, project)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)");
  if (fts) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        title, content, summary, tags, category,
        content = 'memories',
        content_rowid = 'rowid',
        tokenize = 'porter unicode61'
      )
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content, summary, tags, category)
        VALUES (new.rowid, new.title, new.content, coalesce(new.summary, ''), new.tags, coalesce(new.category, ''));
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, summary, tags, category)
        VALUES ('delete', old.rowid, old.title, old.content, coalesce(old.summary, ''), old.tags, coalesce(old.category, ''));
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF title, content, summary, tags, category ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, summary, tags, category)
        VALUES ('delete', old.rowid, old.title, old.content, coalesce(old.summary, ''), old.tags, coalesce(old.category, ''));
        INSERT INTO memories_fts(rowid, title, content, summary, tags, category)
        VALUES (new.rowid, new.title, new.content, coalesce(new.summary, ''), new.tags, coalesce(new.category, ''));
      END
    `);
    const indexed = scalar(db.prepare("SELECT COUNT(*) AS n FROM memories_fts").get());
    const stored = scalar(db.prepare("SELECT COUNT(*) AS n FROM memories").get());
    if (indexed === 0 && stored > 0) db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  }
  db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO NOTHING").run();
}

function asStored(row: Record<string, SQLOutputValue>): Stored {
  const parsed = JSON.parse(String(row["tags"] ?? "[]")) as unknown;
  const tags = Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  const type = String(row["type"]);
  const scope = String(row["scope"]);
  return {
    id: String(row["id"]),
    title: String(row["title"]),
    content: String(row["content"]),
    summary: row["summary"] == null ? null : String(row["summary"]),
    type: isMemoryType(type) ? type : "note",
    category: row["category"] == null ? null : String(row["category"]),
    importance: typeof row["importance"] === "number" ? row["importance"] : 3,
    scope: scope === "global" ? "global" : "project",
    project: row["project"] == null ? null : String(row["project"]),
    source: row["source"] == null ? null : String(row["source"]),
    tags,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    lastAccessedAt: row["last_accessed_at"] == null ? null : String(row["last_accessed_at"]),
    accessCount: typeof row["access_count"] === "number" ? row["access_count"] : 0,
    contentHash: String(row["content_hash"]),
    embeddingModel: row["embedding_model"] == null ? null : String(row["embedding_model"]),
  };
}

function toMemory(stored: Stored): Memory {
  const { contentHash: _contentHash, embeddingModel: _embeddingModel, ...memory } = stored;
  return memory;
}

function assertPlacement(scope: MemoryScope, project: string | null): void {
  if (scope === "global" && project !== null) {
    throw new MemoryRejectedError("Global memories cannot be tied to a project.");
  }
  if (scope === "project" && !project) {
    throw new MemoryRejectedError("Project memories need a project name.");
  }
}

function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

function scalar(row: Record<string, SQLOutputValue> | undefined): number {
  const value = row?.["n"];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function now(): string {
  return new Date().toISOString();
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function vectorLength(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function isConstraint(error: unknown): boolean {
  return error instanceof Error && (error.message.includes("UNIQUE") || error.message.includes("CONSTRAINT"));
}
