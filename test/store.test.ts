import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalHashEmbedder } from "../src/embedding.js";
import { createLogger } from "../src/log.js";
import { prepareAdd } from "../src/prepare.js";
import { SqliteMemoryStore } from "../src/store.js";
import { MemoryConflictError } from "../src/types.js";

function tempDatabase(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-"));
  return {
    path: join(directory, "memory.db"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function openStore(path: string): Promise<SqliteMemoryStore> {
  return SqliteMemoryStore.open({
    databasePath: path,
    embedder: new LocalHashEmbedder(),
    logger: createLogger("error"),
  });
}

test("add, get, update, and delete a memory", async () => {
  const db = tempDatabase();
  const store = await openStore(db.path);
  try {
    const prepared = await prepareAdd({
      content: "Use node:test for unit tests. Do not add Jest.",
      type: "convention",
      importance: 4,
      tags: ["testing", "node"],
      scope: "project",
      project: "agent-memory",
      source: "user",
    }, { defaultProject: null, embedder: new LocalHashEmbedder() });
    const saved = await store.add(prepared.memory);
    assert.equal(saved.duplicate, false);
    assert.equal(saved.memory.type, "convention");
    assert.equal(saved.memory.project, "agent-memory");
    assert.deepEqual(saved.memory.tags, ["testing", "node"]);
    assert.equal(prepared.embeddingStatus, "stored");

    const fetched = await store.get(saved.memory.id, { touch: true });
    assert.ok(fetched);
    assert.equal(fetched.accessCount, 1);
    assert.ok(fetched.lastAccessedAt);

    const updated = await store.update(saved.memory.id, { importance: 5, contentHash: prepared.memory.contentHash });
    assert.equal(updated.importance, 5);

    assert.equal(await store.delete(saved.memory.id), true);
    assert.equal(await store.get(saved.memory.id), null);
    assert.equal(await store.delete(saved.memory.id), false);
  } finally {
    store.close();
    db.cleanup();
  }
});

test("identical content in the same scope is deduplicated", async () => {
  const db = tempDatabase();
  const store = await openStore(db.path);
  try {
    const embedder = new LocalHashEmbedder();
    const first = await prepareAdd({
      content: "User prefers concise explanations and small diffs.",
      scope: "global",
      tags: ["style"],
    }, { defaultProject: null, embedder });
    const second = await prepareAdd({
      content: "User prefers concise explanations and small diffs.",
      scope: "global",
      tags: ["writing"],
      importance: 5,
    }, { defaultProject: null, embedder });
    const saved = await store.add(first.memory);
    const again = await store.add(second.memory);
    assert.equal(again.duplicate, true);
    assert.equal(again.memory.id, saved.memory.id);
    assert.equal(again.memory.importance, 5);
    assert.deepEqual(again.memory.tags, ["style", "writing"]);
    assert.equal((await store.stats()).total, 1);
  } finally {
    store.close();
    db.cleanup();
  }
});

test("the same text can live in two projects", async () => {
  const db = tempDatabase();
  const store = await openStore(db.path);
  try {
    const embedder = new LocalHashEmbedder();
    const left = await prepareAdd({ content: "Use tabs.", scope: "project", project: "alpha" }, { defaultProject: null, embedder });
    const right = await prepareAdd({ content: "Use tabs.", scope: "project", project: "beta" }, { defaultProject: null, embedder });
    await store.add(left.memory);
    await store.add(right.memory);
    assert.equal((await store.stats()).total, 2);
  } finally {
    store.close();
    db.cleanup();
  }
});

test("search finds stemmed words and keeps projects apart", async () => {
  const db = tempDatabase();
  const store = await openStore(db.path);
  try {
    const embedder = new LocalHashEmbedder();
    const tests = await prepareAdd({
      content: "Unit tests use node:test and stay in the test directory.",
      type: "convention",
      project: "agent-memory",
      scope: "project",
      importance: 5,
    }, { defaultProject: null, embedder });
    const global = await prepareAdd({
      content: "User prefers pnpm over npm.",
      type: "preference",
      scope: "global",
      importance: 4,
    }, { defaultProject: null, embedder });
    const other = await prepareAdd({
      content: "The other repo deploys tests with a bash script.",
      type: "fact",
      project: "other-repo",
      scope: "project",
    }, { defaultProject: null, embedder });
    await store.add(tests.memory);
    await store.add(global.memory);
    await store.add(other.memory);

    const found = await store.search("testing", { project: "agent-memory", includeGlobal: true }, { limit: 8, mode: "keyword" });
    assert.ok(found.hits.some((hit) => hit.memory.content.includes("node:test")));
    assert.equal(found.hits.some((hit) => hit.memory.project === "other-repo"), false);

    const projectOnly = await store.search("pnpm", { project: "agent-memory", includeGlobal: false }, { limit: 8, mode: "keyword" });
    assert.equal(projectOnly.hits.length, 0);

    const withGlobal = await store.search("pnpm", { project: "agent-memory", includeGlobal: true }, { limit: 8, mode: "keyword" });
    assert.equal(withGlobal.hits.length, 1);
    assert.equal(withGlobal.hits[0]?.memory.scope, "global");
  } finally {
    store.close();
    db.cleanup();
  }
});

test("semantic search connects related wording", async () => {
  const db = tempDatabase();
  const store = await openStore(db.path);
  try {
    const embedder = new LocalHashEmbedder();
    const preference = await prepareAdd({
      content: "User prefers TypeScript for application code.",
      type: "preference",
      scope: "global",
    }, { defaultProject: null, embedder });
    const unrelated = await prepareAdd({
      content: "The staging database is restored from last night's snapshot.",
      type: "fact",
      scope: "global",
    }, { defaultProject: null, embedder });
    await store.add(preference.memory);
    await store.add(unrelated.memory);

    const found = await store.search("typescript preference", {}, { limit: 5, mode: "semantic" });
    assert.ok(found.hits.length >= 1);
    const preferenceId = (await store.list({}, { limit: 10, offset: 0, sort: "recent" })).memories.find((memory) => memory.content.includes("TypeScript"))?.id;
    assert.equal(found.hits[0]?.memory.id, preferenceId);
    assert.equal(found.hits[0]?.memory.content.includes("TypeScript"), true);
    assert.equal(found.hits.some((hit) => hit.memory.content.includes("snapshot")), false);
  } finally {
    store.close();
    db.cleanup();
  }
});

test("list filters by tag and importance", async () => {
  const db = tempDatabase();
  const store = await openStore(db.path);
  try {
    const embedder = new LocalHashEmbedder();
    await store.add((await prepareAdd({ content: "Run lint before pushing.", tags: ["git"], importance: 2, scope: "global" }, { defaultProject: null, embedder })).memory);
    await store.add((await prepareAdd({ content: "Squash fixup commits.", tags: ["git"], importance: 5, scope: "global" }, { defaultProject: null, embedder })).memory);
    const page = await store.list({ tags: ["git"], minImportance: 4 }, { limit: 10, offset: 0, sort: "importance" });
    assert.equal(page.total, 1);
    assert.equal(page.memories[0]?.importance, 5);
  } finally {
    store.close();
    db.cleanup();
  }
});

test("updating onto an existing memory reports the conflict", async () => {
  const db = tempDatabase();
  const store = await openStore(db.path);
  try {
    const embedder = new LocalHashEmbedder();
    const first = await store.add((await prepareAdd({ content: "Prefer vitest.", scope: "global", type: "preference" }, { defaultProject: null, embedder })).memory);
    const second = await store.add((await prepareAdd({ content: "Prefer node:test.", scope: "global", type: "preference" }, { defaultProject: null, embedder })).memory);
    const replacement = await prepareAdd({ content: "Prefer vitest.", scope: "global", type: "preference" }, { defaultProject: null, embedder });
    await assert.rejects(
      () => store.update(second.memory.id, { content: replacement.memory.content, contentHash: replacement.memory.contentHash }),
      (error: unknown) => error instanceof MemoryConflictError && error.existingId === first.memory.id,
    );
  } finally {
    store.close();
    db.cleanup();
  }
});

test("clear removes only the filtered rows", async () => {
  const db = tempDatabase();
  const store = await openStore(db.path);
  try {
    const embedder = new LocalHashEmbedder();
    await store.add((await prepareAdd({ content: "Global preference.", scope: "global", type: "preference" }, { defaultProject: null, embedder })).memory);
    await store.add((await prepareAdd({ content: "Project fact.", scope: "project", project: "demo", type: "fact" }, { defaultProject: null, embedder })).memory);
    assert.equal(await store.clear({ scope: "project", project: "demo" }), 1);
    assert.equal((await store.stats()).total, 1);
    assert.equal((await store.stats()).byScope.global, 1);
  } finally {
    store.close();
    db.cleanup();
  }
});
