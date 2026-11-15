import * as z from "zod/v4";

import { MEMORY_SCOPES, MEMORY_TYPES, SEARCH_MODES } from "./types.js";

export const memoryTypeSchema = z.enum(MEMORY_TYPES);
export const memoryScopeSchema = z.enum(MEMORY_SCOPES);
export const searchModeSchema = z.enum(SEARCH_MODES);

export const memoryCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  preview: z.string(),
  type: memoryTypeSchema,
  category: z.string().nullable(),
  importance: z.number().int(),
  scope: memoryScopeSchema,
  project: z.string().nullable(),
  tags: z.array(z.string()),
  updated_at: z.string(),
});

export const memoryViewSchema = memoryCardSchema.extend({
  content: z.string(),
  summary: z.string().nullable(),
  source: z.string().nullable(),
  created_at: z.string(),
  last_accessed_at: z.string().nullable(),
  access_count: z.number().int(),
});

const typeField = memoryTypeSchema.optional().describe("fact, preference, decision, convention, or note. Inferred from the text when omitted.");
const categoryField = z.string().max(40).optional().describe("Short bucket such as testing, git, or style.");
const tagsField = z.array(z.string().min(1).max(40)).max(12).optional().describe("Short labels. Normalized to lowercase kebab-case. Inferred when omitted on add.");
const importanceField = z.number().int().min(1).max(5).optional().describe("1 is minor, 3 is normal, 5 should always be applied.");
const scopeField = z.enum(MEMORY_SCOPES).optional().describe("project for this repo, global for the user across repos. Defaults to project when a project name is known.");
const projectField = z.string().min(1).max(80).optional().describe("Project name. Defaults to AGENT_MEMORY_PROJECT or the git root folder name.");
const includeGlobalField = z.boolean().optional().describe("When a project is selected, also return global memories. Defaults to true.");
const minImportanceField = z.number().int().min(1).max(5).optional().describe("Drop memories below this importance.");

export const addInputSchema = z.object({
  content: z.string().min(1).max(16_000).describe("One self-contained memory. State the rule or fact, not the conversation that produced it."),
  title: z.string().min(1).max(140).optional().describe("Short label. Defaults to the first sentence of content."),
  type: typeField,
  category: categoryField,
  importance: importanceField,
  tags: tagsField,
  scope: scopeField,
  project: projectField,
  source: z.string().max(160).optional().describe("Where this came from, such as user or a file path. Do not put secrets here."),
});

export const searchInputSchema = z.object({
  query: z.string().min(2).max(500).describe("Natural-language search text. Short and specific works better than a paragraph."),
  type: typeField,
  category: categoryField,
  tags: tagsField,
  min_importance: minImportanceField,
  scope: scopeField,
  project: projectField,
  include_global: includeGlobalField,
  limit: z.number().int().min(1).max(25).optional().describe("Maximum cards to return. Defaults to 8."),
  mode: searchModeSchema.optional().describe("hybrid (default) blends keyword and semantic scores. keyword uses full-text search. semantic uses embeddings only."),
});

export const getInputSchema = z.object({
  id: z.string().min(1).describe("Memory id, for example mem_ab12cd34ef567890."),
});

export const listInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().describe("Page size. Defaults to 20."),
  offset: z.number().int().min(0).max(10_000).optional().describe("Number of matches to skip. Defaults to 0."),
  sort: z.enum(["recent", "importance"]).optional().describe("recent (default) or importance."),
  type: typeField,
  category: categoryField,
  tags: tagsField,
  min_importance: minImportanceField,
  scope: scopeField,
  project: projectField,
  include_global: includeGlobalField,
});

export const updateInputSchema = z.object({
  id: z.string().min(1).describe("Id of the memory to change."),
  content: z.string().min(1).max(16_000).optional().describe("Replacement text. Omit to leave the content unchanged."),
  title: z.string().min(1).max(140).optional(),
  type: typeField,
  category: z.string().max(40).nullable().optional().describe("Pass null to clear the category."),
  importance: importanceField,
  tags: tagsField,
  scope: scopeField,
  project: z.string().min(1).max(80).nullable().optional().describe("Project name. Ignored when setting scope to global."),
  source: z.string().max(160).nullable().optional().describe("Pass null to clear the source."),
});

export const clearInputSchema = z.object({
  all: z.boolean().optional().describe("Delete every memory. Requires confirm \"DELETE ALL MEMORIES\". Do not combine with filters."),
  confirm: z.string().optional().describe("Exact confirmation phrase returned by a preview call. Nothing is deleted without it."),
  type: typeField,
  category: categoryField,
  tags: tagsField,
  min_importance: minImportanceField,
  scope: scopeField,
  project: projectField,
  include_global: includeGlobalField,
});

export const searchHitSchema = memoryCardSchema.extend({
  score: z.number(),
  keyword: z.number(),
  semantic: z.number(),
});
