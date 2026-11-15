import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { LocalHashEmbedder } from "../src/embedding.js";
import { createLogger } from "../src/log.js";
import { createServer } from "../src/server.js";
import { SqliteMemoryStore } from "../src/store.js";

function textOf(result: { content?: unknown }): string {
  if (!Array.isArray(result.content) || result.content.length === 0) return "";
  const block = result.content[0] as { text?: string };
  return block.text ?? "";
}

test("MCP client can store, search, update, and safely clear memories", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-mcp-"));
  const store = await SqliteMemoryStore.open({
    databasePath: join(directory, "memory.db"),
    embedder: new LocalHashEmbedder(),
    logger: createLogger("error"),
  });
  const server = createServer({
    store,
    embedder: new LocalHashEmbedder(),
    config: { project: "agent-memory" },
    logger: createLogger("error"),
  });
  const client = new Client({ name: "agent-memory-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "memory_add",
      "memory_clear",
      "memory_delete",
      "memory_get",
      "memory_list",
      "memory_search",
      "memory_stats",
      "memory_update",
    ]);

    const secret = await client.callTool({
      name: "memory_add",
      arguments: { content: "api_key=abcdEFGH1234567890zz", scope: "global" },
    });
    assert.equal(secret.isError, true);
    assert.match(textOf(secret), /secret/i);

    const added = await client.callTool({
      name: "memory_add",
      arguments: {
        content: "User prefers concise explanations and small diffs.",
        type: "preference",
        importance: 5,
        scope: "global",
        tags: ["style"],
      },
    });
    assert.notEqual(added.isError, true);
    const addedBody = added.structuredContent as { id: string; duplicate: boolean; memory: { type: string } };
    assert.equal(addedBody.duplicate, false);
    assert.equal(addedBody.memory.type, "preference");
    assert.match(textOf(added), /Stored memory/);

    const duplicate = await client.callTool({
      name: "memory_add",
      arguments: { content: "User prefers concise explanations and small diffs.", scope: "global", tags: ["prose"] },
    });
    const duplicateBody = duplicate.structuredContent as { duplicate: boolean; id: string };
    assert.equal(duplicateBody.duplicate, true);
    assert.equal(duplicateBody.id, addedBody.id);

    const projectMemory = await client.callTool({
      name: "memory_add",
      arguments: {
        content: "In this repo, tests use node:test. Do not add Jest.",
        type: "convention",
        tags: ["testing"],
      },
    });
    const projectBody = projectMemory.structuredContent as { memory: { scope: string; project: string } };
    assert.equal(projectBody.memory.scope, "project");
    assert.equal(projectBody.memory.project, "agent-memory");

    const search = await client.callTool({
      name: "memory_search",
      arguments: { query: "testing convention" },
    });
    const searchBody = search.structuredContent as { memories: { id: string; preview: string }[] };
    assert.ok(searchBody.memories.length >= 1);
    assert.match(textOf(search), /node:test/);
    assert.ok(searchBody.memories.every((memory) => memory.preview.length < 400));

    const fetched = await client.callTool({
      name: "memory_get",
      arguments: { id: addedBody.id },
    });
    assert.match(textOf(fetched), /small diffs/);

    const updated = await client.callTool({
      name: "memory_update",
      arguments: { id: addedBody.id, importance: 4 },
    });
    const updatedBody = updated.structuredContent as { memory: { importance: number } };
    assert.equal(updatedBody.memory.importance, 4);

    const preview = await client.callTool({
      name: "memory_clear",
      arguments: { scope: "project", project: "agent-memory" },
    });
    assert.notEqual(preview.isError, true);
    const previewBody = preview.structuredContent as { deleted: boolean; confirm?: string };
    assert.equal(previewBody.deleted, false);
    assert.equal(previewBody.confirm, "DELETE MATCHING MEMORIES");
    assert.match(textOf(preview), /Nothing was deleted/);

    const refused = await client.callTool({ name: "memory_clear", arguments: {} });
    assert.equal(refused.isError, true);

    const cleared = await client.callTool({
      name: "memory_clear",
      arguments: { scope: "project", project: "agent-memory", confirm: "DELETE MATCHING MEMORIES" },
    });
    const clearedBody = cleared.structuredContent as { deleted: boolean; count: number };
    assert.equal(clearedBody.deleted, true);
    assert.equal(clearedBody.count, 1);

    const stats = await client.callTool({ name: "memory_stats", arguments: {} });
    const statsBody = stats.structuredContent as { total: number; fts: boolean };
    assert.equal(statsBody.total, 1);
    assert.equal(statsBody.fts, true);

    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "memory://guide"));
    const guide = await client.readResource({ uri: "memory://guide" });
    const guideText = guide.contents[0] && "text" in guide.contents[0] ? guide.contents[0].text : "";
    assert.match(guideText, /When to search/);

    const prompts = await client.listPrompts();
    assert.ok(prompts.prompts.some((prompt) => prompt.name === "recall-context"));
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
