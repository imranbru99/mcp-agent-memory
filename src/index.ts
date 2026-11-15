#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config.js";
import { createEmbeddingProvider } from "./embedding.js";
import { createLogger, silenceSqliteExperimentalWarning } from "./log.js";
import { createServer } from "./server.js";
import { SqliteMemoryStore } from "./store.js";
import { VERSION } from "./version.js";

silenceSqliteExperimentalWarning();

const HELP = `agent-memory ${VERSION}

Usage:
  agent-memory            Start the MCP server on stdio
  agent-memory path       Print the SQLite database path
  agent-memory stats      Print memory counts as JSON
  agent-memory help       Show this help

Environment:
  AGENT_MEMORY_DB                 Database file (default ~/.agent-memory/memory.db)
  AGENT_MEMORY_PROJECT            Project name (default: git root folder name)
  AGENT_MEMORY_EMBEDDINGS         local (default), off, or http
  AGENT_MEMORY_EMBEDDING_URL      OpenAI-compatible /embeddings endpoint
  AGENT_MEMORY_EMBEDDING_MODEL    Model name used when embeddings=http
  AGENT_MEMORY_EMBEDDING_API_KEY  Bearer token for the embedding endpoint
  AGENT_MEMORY_LOG                debug, info, warn, or error
  AGENT_MEMORY_CONFIG             Optional JSON config file

Logs are written to stderr. stdout is reserved for the MCP protocol.
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "help" || command === "--help" || command === "-h") {
    console.error(HELP);
    return;
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (command === "path") {
    console.log(config.databasePath);
    return;
  }
  if (command && command !== "stats") {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  const embedder = createEmbeddingProvider(config, logger);
  const store = await SqliteMemoryStore.open({ databasePath: config.databasePath, embedder, logger });

  if (command === "stats") {
    console.log(JSON.stringify(await store.stats(), null, 2));
    store.close();
    return;
  }

  logger.info("listening on stdio", {
    database: config.databasePath,
    project: config.project,
    embeddings: embedder.id,
  });

  const handle = serveStdio(() => createServer({ store, embedder, config, logger }), {
    onerror: (error) => logger.error("stdio error", { error: error.message }),
  });

  const shutdown = async (): Promise<void> => {
    store.close();
    await handle.close();
  };
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[agent-memory] fatal ${message}`);
  process.exit(1);
});
