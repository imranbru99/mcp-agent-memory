import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import type { EmbeddingProvider } from "./embedding.js";
import { describeFilter, formatDetail, formatList, formatSearch, formatStored, toCard, toView } from "./format.js";
import { GUIDE, INSTRUCTIONS } from "./guide.js";
import type { Logger } from "./log.js";
import { prepareAdd, prepareUpdate, resolveReadFilter } from "./prepare.js";
import {
  addInputSchema,
  clearInputSchema,
  getInputSchema,
  listInputSchema,
  memoryCardSchema,
  memoryViewSchema,
  searchHitSchema,
  searchInputSchema,
  updateInputSchema,
} from "./schemas.js";
import type { MemoryStore } from "./store.js";
import { MemoryConflictError, MemoryNotFoundError, MemoryRejectedError, type Memory, type MemoryFilter } from "./types.js";
import { SERVER_NAME, VERSION } from "./version.js";

const DELETE_ALL = "DELETE ALL MEMORIES";
const DELETE_MATCHING = "DELETE MATCHING MEMORIES";

export interface ServerDeps {
  store: MemoryStore;
  embedder: EmbeddingProvider;
  config: Pick<AppConfig, "project">;
  logger: Logger;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION, title: "Agent Memory" },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server);
  return server;
}

function registerTools(server: McpServer, deps: ServerDeps): void {
  const { store, embedder, config, logger } = deps;

  server.registerTool(
    "memory_add",
    {
      title: "Save memory",
      description: "Save one durable memory that should survive this session. Use it for a user preference, a project convention, a decision, or a stable fact. Write one self-contained statement. Do not store secrets, transcripts, diffs, or temporary notes. The same text, type, and scope is stored once.",
      inputSchema: addInputSchema,
      outputSchema: z.object({
        id: z.string(),
        duplicate: z.boolean(),
        embedding: z.enum(["off", "stored", "unavailable"]),
        memory: memoryViewSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => guard(logger, "memory_add", async () => {
      const prepared = await prepareAdd(input, { defaultProject: config.project, embedder });
      const saved = await store.add(prepared.memory);
      logger.info("memory_add", { id: saved.memory.id, type: saved.memory.type, scope: saved.memory.scope, duplicate: saved.duplicate });
      return ok(formatStored(saved.memory, saved.duplicate, prepared.embeddingStatus), {
        id: saved.memory.id,
        duplicate: saved.duplicate,
        embedding: prepared.embeddingStatus,
        memory: toView(saved.memory),
      });
    }),
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description: "Search long-term memory before assuming a preference, convention, or past decision. Call this at the start of project work and when the user says \"as usual\", \"last time\", or \"we decided\". Hybrid search blends keywords with embeddings, then ranks by importance and recency. Returns short cards. Use memory_get for the full text.",
      inputSchema: searchInputSchema,
      outputSchema: z.object({
        query: z.string(),
        mode: z.enum(["hybrid", "keyword", "semantic"]),
        scope: z.string(),
        memories: z.array(searchHitSchema),
        note: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => guard(logger, "memory_search", async () => {
      const filter = resolveReadFilter({
        type: input.type,
        category: input.category,
        tags: input.tags,
        minImportance: input.min_importance,
        scope: input.scope,
        project: input.project,
        includeGlobal: input.include_global,
      }, config.project);
      const result = await store.search(input.query, filter, { limit: input.limit ?? 8, mode: input.mode ?? "hybrid" });
      const scope = describeFilter(filter);
      logger.debug("memory_search", { hits: result.hits.length, mode: result.mode });
      const memories = result.hits.map((hit) => ({
        ...toCard(hit.memory),
        score: hit.score,
        keyword: hit.keyword,
        semantic: hit.semantic,
      }));
      return ok(formatSearch(input.query, result.hits, scope, result.mode, result.note), {
        query: input.query,
        mode: result.mode,
        scope,
        memories,
        ...(result.note ? { note: result.note } : {}),
      });
    }),
  );

  server.registerTool(
    "memory_get",
    {
      title: "Get memory",
      description: "Fetch one memory by id, including its full text. Use this when a search or list card is not enough.",
      inputSchema: getInputSchema,
      outputSchema: z.object({ memory: memoryViewSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => guard(logger, "memory_get", async () => {
      const memory = await store.get(id, { touch: true });
      if (!memory) throw new MemoryNotFoundError(id);
      return ok(formatDetail(memory), { memory: toView(memory) });
    }),
  );

  server.registerTool(
    "memory_list",
    {
      title: "List memories",
      description: "List recent or important memories. Use this to browse what is stored, not to answer a specific question (use memory_search for that). Returns short cards.",
      inputSchema: listInputSchema,
      outputSchema: z.object({
        total: z.number().int(),
        scope: z.string(),
        memories: z.array(memoryCardSchema),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => guard(logger, "memory_list", async () => {
      const filter = resolveReadFilter({
        type: input.type,
        category: input.category,
        tags: input.tags,
        minImportance: input.min_importance,
        scope: input.scope,
        project: input.project,
        includeGlobal: input.include_global,
      }, config.project);
      const page = await store.list(filter, { limit: input.limit ?? 20, offset: input.offset ?? 0, sort: input.sort ?? "recent" });
      const scope = describeFilter(filter);
      return ok(formatList(page.memories, page.total, scope), {
        total: page.total,
        scope,
        memories: page.memories.map(toCard),
      });
    }),
  );

  server.registerTool(
    "memory_update",
    {
      title: "Update memory",
      description: "Change an existing memory. Use this when a decision or preference changes instead of adding a contradicting memory. Pass only the fields that should change.",
      inputSchema: updateInputSchema,
      outputSchema: z.object({
        memory: memoryViewSchema,
        embedding: z.enum(["off", "stored", "unavailable", "unchanged"]),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => guard(logger, "memory_update", async () => {
      const existing = await store.get(input.id);
      if (!existing) throw new MemoryNotFoundError(input.id);
      const prepared = await prepareUpdate(existing, {
        title: input.title,
        content: input.content,
        type: input.type,
        category: input.category,
        importance: input.importance,
        tags: input.tags,
        scope: input.scope,
        project: input.project,
        source: input.source,
      }, { defaultProject: config.project, embedder });
      const memory = await store.update(input.id, prepared.patch);
      logger.info("memory_update", { id: memory.id });
      return ok(`Updated memory ${memory.id}.\n${formatDetail(memory)}`, {
        memory: toView(memory),
        embedding: prepared.embeddingStatus,
      });
    }),
  );

  server.registerTool(
    "memory_delete",
    {
      title: "Delete memory",
      description: "Delete one memory by id. This cannot be undone. Use memory_update when the memory should change rather than disappear.",
      inputSchema: getInputSchema,
      outputSchema: z.object({ id: z.string(), deleted: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => guard(logger, "memory_delete", async () => {
      const deleted = await store.delete(id);
      if (!deleted) throw new MemoryNotFoundError(id);
      logger.info("memory_delete", { id });
      return ok(`Deleted memory ${id}.`, { id, deleted: true });
    }),
  );

  server.registerTool(
    "memory_clear",
    {
      title: "Clear memories",
      description: "Delete a set of memories. The first call only previews the count and returns a confirmation phrase. Nothing is deleted until a second call sends that exact phrase in confirm. Deleting everything requires all:true and confirm \"DELETE ALL MEMORIES\". An unfiltered clear without all:true is refused.",
      inputSchema: clearInputSchema,
      outputSchema: z.object({
        deleted: z.boolean(),
        count: z.number().int(),
        scope: z.string(),
        confirm: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => guard(logger, "memory_clear", async () => clearMemories(store, logger, config.project, input)),
  );

  server.registerTool(
    "memory_stats",
    {
      title: "Memory stats",
      description: "Show how many memories are stored by type, scope, and project, plus whether full-text search and embeddings are active.",
      outputSchema: z.object({
        total: z.number().int(),
        by_type: z.object({
          fact: z.number().int(),
          preference: z.number().int(),
          decision: z.number().int(),
          convention: z.number().int(),
          note: z.number().int(),
        }),
        by_scope: z.object({ global: z.number().int(), project: z.number().int() }),
        projects: z.array(z.object({ project: z.string(), count: z.number().int() })),
        fts: z.boolean(),
        embedding_model: z.string(),
        database_path: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => guard(logger, "memory_stats", async () => {
      const stats = await store.stats();
      const projects = stats.projects.map((item) => `${item.project} ${item.count}`).join(", ") || "none";
      const text = [
        `${stats.total} memories in ${stats.databasePath}`,
        `full-text search: ${stats.fts ? "on" : "off"} · embeddings: ${stats.embeddingModel}`,
        `fact ${stats.byType.fact} · preference ${stats.byType.preference} · decision ${stats.byType.decision} · convention ${stats.byType.convention} · note ${stats.byType.note}`,
        `global ${stats.byScope.global} · project ${stats.byScope.project}`,
        `projects: ${projects}`,
      ].join("\n");
      return ok(text, {
        total: stats.total,
        by_type: stats.byType,
        by_scope: stats.byScope,
        projects: stats.projects,
        fts: stats.fts,
        embedding_model: stats.embeddingModel,
        database_path: stats.databasePath,
      });
    }),
  );
}

async function clearMemories(
  store: MemoryStore,
  logger: Logger,
  defaultProject: string | null,
  input: {
    all?: boolean;
    confirm?: string;
    type?: Memory["type"];
    category?: string;
    tags?: string[];
    min_importance?: number;
    scope?: Memory["scope"];
    project?: string;
    include_global?: boolean;
  },
): Promise<ToolResult> {
  const hasFilter = Boolean(input.type || input.category || (input.tags && input.tags.length > 0) || input.min_importance || input.scope || input.project || input.include_global !== undefined);
  if (input.all && hasFilter) {
    throw new MemoryRejectedError("Pass either all:true or filters, not both. Nothing was deleted.");
  }
  if (!input.all && !hasFilter) {
    throw new MemoryRejectedError(`Refusing to delete every memory without an explicit scope. Pass filters, or set all:true and confirm "${DELETE_ALL}". Nothing was deleted.`);
  }
  const filter: MemoryFilter = input.all ? {} : resolveReadFilter({
    type: input.type,
    category: input.category,
    tags: input.tags,
    minImportance: input.min_importance,
    scope: input.scope,
    project: input.project,
    includeGlobal: input.include_global,
  }, defaultProject);
  const unscoped = input.all || isUnscoped(filter);
  const scope = unscoped ? "all memories" : describeFilter(filter);
  const count = await store.count(unscoped ? {} : filter);
  const phrase = unscoped ? DELETE_ALL : DELETE_MATCHING;
  if (count === 0) {
    return ok(`No memories matched (${scope}). Nothing was deleted.`, { deleted: false, count: 0, scope });
  }
  if (input.confirm !== phrase) {
    return ok(
      `Would delete ${count} memor${count === 1 ? "y" : "ies"} (${scope}). Nothing was deleted. To delete them, call memory_clear again with the same arguments and confirm: "${phrase}".`,
      { deleted: false, count, scope, confirm: phrase },
    );
  }
  const deleted = await store.clear(unscoped ? {} : filter);
  logger.info("memory_clear", { deleted, scope });
  return ok(`Deleted ${deleted} memor${deleted === 1 ? "y" : "ies"} (${scope}).`, { deleted: true, count: deleted, scope });
}

function registerResources(server: McpServer, deps: ServerDeps): void {
  server.registerResource(
    "guide",
    "memory://guide",
    {
      title: "How to use memory",
      description: "When to save, search, and update long-term memory.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }],
    }),
  );

  server.registerResource(
    "recent",
    "memory://recent",
    {
      title: "Recent memories",
      description: "The newest memories for the current project and global scope.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      try {
        const filter = resolveReadFilter({}, deps.config.project);
        const page = await deps.store.list(filter, { limit: 15, offset: 0, sort: "recent" });
        const body = page.memories.length === 0
          ? "No memories yet."
          : page.memories.map((memory) => `- **${memory.title}** (\`${memory.id}\`, ${memory.type}, importance ${memory.importance}, ${memory.scope === "project" ? memory.project : "global"})`).join("\n");
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/markdown",
            text: `# Recent memories\n\n${describeFilter(filter)} · ${page.total} total\n\n${body}`,
          }],
        };
      } catch (error) {
        deps.logger.error("memory://recent failed", { error: error instanceof Error ? error.message : String(error) });
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Could not read recent memories." }] };
      }
    },
  );
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "recall-context",
    {
      title: "Recall context",
      description: "Search memory before starting a task and apply what comes back.",
      argsSchema: z.object({
        task: z.string().min(1).describe("What you are about to work on"),
      }),
    },
    ({ task }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Before working on this task, search long-term memory and apply anything relevant.\n\nTask: ${task}\n\nCall memory_search with a short query from the task. Keep the default scope so project memories and global preferences both come back. Call memory_get when a card is not enough. Follow stored preferences, conventions, and decisions. If you make a new durable decision, call memory_add.`,
        },
      }],
    }),
  );

  server.registerPrompt(
    "capture-memories",
    {
      title: "Capture memories",
      description: "Extract durable memories from notes and save them with memory_add.",
      argsSchema: z.object({
        notes: z.string().min(1).describe("Conversation notes or decisions to distill"),
      }),
    },
    ({ notes }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Extract only durable memories from the notes below. Save each one with memory_add.\n\nKeep a memory when it is a preference, decision, convention, or stable fact that should still matter next week. Skip chatter, secrets, and temporary state. Write each memory as one self-contained statement. Search first so you update an existing memory instead of saving a contradiction.\n\nNotes:\n${notes}`,
        },
      }],
    }),
  );
}

function isUnscoped(filter: MemoryFilter): boolean {
  return filter.scope === undefined
    && filter.project === undefined
    && filter.type === undefined
    && !filter.category
    && !(filter.tags && filter.tags.length > 0)
    && filter.minImportance === undefined;
}

function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

async function guard(logger: Logger, tool: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Memory request failed.";
    const known = error instanceof MemoryNotFoundError || error instanceof MemoryConflictError || error instanceof MemoryRejectedError;
    if (known) logger.info(`${tool} rejected`, { error: message });
    else logger.error(`${tool} failed`, { error: message });
    return {
      isError: true,
      content: [{ type: "text", text: known ? message : "Memory request failed. Check the server log for details." }],
    };
  }
}
