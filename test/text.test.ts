import assert from "node:assert/strict";
import test from "node:test";

import { cosine, hashEmbed } from "../src/embedding.js";
import { MemoryRejectedError } from "../src/types.js";
import {
  assertNoSecrets,
  autoTags,
  contentHash,
  inferType,
  summarize,
  titleFromContent,
} from "../src/text.js";
import { resolvePlacement, resolveReadFilter } from "../src/prepare.js";

test("type inference follows the wording", () => {
  assert.equal(inferType("User prefers small pull requests."), "preference");
  assert.equal(inferType("We decided to use SQLite."), "decision");
  assert.equal(inferType("In this repo, tests use node:test."), "convention");
  assert.equal(inferType("The database file lives in the home directory."), "fact");
});

test("long memories get a short summary and a title", () => {
  const content = `Prefer narrow changes. ${"This sentence adds bulk. ".repeat(40)}`;
  assert.ok(content.length > 320);
  const summary = summarize(content);
  assert.ok(summary);
  assert.ok(summary.length < content.length);
  assert.equal(titleFromContent(content), "Prefer narrow changes.");
});

test("secrets are rejected and ordinary notes are kept", () => {
  assert.throws(() => assertNoSecrets("api_key=sk-live-abcdef1234567890"), MemoryRejectedError);
  assert.throws(() => assertNoSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nabc"), MemoryRejectedError);
  assert.doesNotThrow(() => assertNoSecrets("The API key lives in .env. Never commit it."));
});

test("automatic tags keep identifiers and skip stopwords", () => {
  const tags = autoTags("Use node:test and better error handling in src/store.ts.", "Testing convention");
  assert.ok(tags.includes("node-test"));
  assert.ok(tags.includes("store.ts"));
  assert.equal(tags.includes("use"), false);
  assert.ok(tags.length <= 6);
});

test("content hash changes with scope and ignores case and spacing", () => {
  const left = contentHash({ scope: "global", project: null, type: "fact", content: "Use  Pnpm." });
  const right = contentHash({ scope: "global", project: null, type: "fact", content: "use pnpm." });
  const other = contentHash({ scope: "project", project: "app", type: "fact", content: "use pnpm." });
  assert.equal(left, right);
  assert.notEqual(left, other);
});

test("placement defaults to the current project and can be global", () => {
  assert.deepEqual(resolvePlacement({}, "agent-memory"), { scope: "project", project: "agent-memory" });
  assert.deepEqual(resolvePlacement({ scope: "global" }, "agent-memory"), { scope: "global", project: null });
  assert.throws(() => resolvePlacement({ scope: "global", project: "app" }, null), MemoryRejectedError);
});

test("read filters include global memories unless asked not to", () => {
  assert.deepEqual(resolveReadFilter({}, "agent-memory"), { project: "agent-memory", includeGlobal: true });
  assert.deepEqual(resolveReadFilter({ includeGlobal: false }, "agent-memory"), {
    project: "agent-memory",
    includeGlobal: false,
  });
  assert.deepEqual(resolveReadFilter({ scope: "global" }, "agent-memory"), { scope: "global" });
});

test("related sentences embed closer than unrelated ones", () => {
  const preference = hashEmbed("User prefers TypeScript for application code");
  const related = hashEmbed("typescript preference for the application");
  const unrelated = hashEmbed("staging database snapshot from last night");
  const same = cosine(preference, hashEmbed("User prefers TypeScript for application code"));
  assert.ok(Math.abs(same - 1) < 0.001);
  assert.ok(cosine(preference, related) > cosine(preference, unrelated));
  assert.ok(cosine(preference, related) >= 0.42);
  assert.ok(cosine(preference, unrelated) < 0.42);
});
