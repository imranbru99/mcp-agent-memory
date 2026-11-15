import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { createEmbeddingProvider } from "../src/embedding.js";
import { createLogger } from "../src/log.js";
import { prepareAdd, type AddInput } from "../src/prepare.js";
import { SqliteMemoryStore } from "../src/store.js";
import { MEMORY_SCOPES, MEMORY_TYPES, type MemoryScope, type MemoryType } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, "memories.json"), "utf8")) as unknown;
if (!Array.isArray(raw)) throw new Error("examples/memories.json must be an array.");

const config = loadConfig();
const logger = createLogger(config.logLevel);
const embedder = createEmbeddingProvider(config, logger);
const store = await SqliteMemoryStore.open({ databasePath: config.databasePath, embedder, logger });

try {
  for (const entry of raw) {
    const input = asAddInput(entry);
    const prepared = await prepareAdd(input, { defaultProject: config.project, embedder });
    const saved = await store.add(prepared.memory);
    const status = saved.duplicate ? "duplicate" : "stored";
    console.log(`${status} ${saved.memory.id} ${saved.memory.type} ${saved.memory.scope}`);
  }
} finally {
  store.close();
}

function asAddInput(value: unknown): AddInput {
  if (!value || typeof value !== "object") throw new Error("Each example must be an object.");
  const record = value as Record<string, unknown>;
  if (typeof record["content"] !== "string") throw new Error("Each example needs a content string.");
  const type = record["type"];
  const scope = record["scope"];
  if (typeof type !== "string" || !MEMORY_TYPES.includes(type as MemoryType)) {
    throw new Error(`Example type must be one of ${MEMORY_TYPES.join(", ")}.`);
  }
  if (typeof scope !== "string" || !MEMORY_SCOPES.includes(scope as MemoryScope)) {
    throw new Error(`Example scope must be one of ${MEMORY_SCOPES.join(", ")}.`);
  }
  return {
    content: record["content"],
    type: type as MemoryType,
    scope: scope as MemoryScope,
    ...(typeof record["project"] === "string" ? { project: record["project"] } : {}),
    ...(typeof record["importance"] === "number" ? { importance: record["importance"] } : {}),
    ...(Array.isArray(record["tags"]) ? { tags: record["tags"].filter((tag): tag is string => typeof tag === "string") } : {}),
    source: "examples/memories.json",
  };
}
