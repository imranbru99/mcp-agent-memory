import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { LOG_LEVELS, type LogLevel } from "./log.js";

export type EmbeddingMode = "local" | "off" | "http";

export interface AppConfig {
  databasePath: string;
  project: string | null;
  embeddings: EmbeddingMode;
  embeddingUrl: string | null;
  embeddingModel: string;
  embeddingApiKey: string | null;
  logLevel: LogLevel;
}

interface FileConfig {
  database?: string;
  project?: string | null;
  embeddings?: EmbeddingMode;
  embeddingUrl?: string;
  embeddingModel?: string;
  embeddingApiKey?: string;
  logLevel?: LogLevel;
}

const EMBEDDING_MODES = new Set<EmbeddingMode>(["local", "off", "http"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const file = readConfigFile(env["AGENT_MEMORY_CONFIG"]);
  const embeddings = pickEnum(env["AGENT_MEMORY_EMBEDDINGS"], file.embeddings, EMBEDDING_MODES, "local", "AGENT_MEMORY_EMBEDDINGS");
  const embeddingUrl = pickString(env["AGENT_MEMORY_EMBEDDING_URL"], file.embeddingUrl) ?? null;
  if (embeddings === "http" && !embeddingUrl) {
    throw new Error("AGENT_MEMORY_EMBEDDINGS=http requires AGENT_MEMORY_EMBEDDING_URL (an OpenAI-compatible /embeddings endpoint).");
  }

  const projectFromEnv = env["AGENT_MEMORY_PROJECT"];
  const project = projectFromEnv !== undefined
    ? blankToNull(projectFromEnv)
    : file.project !== undefined
      ? blankToNull(file.project)
      : inferGitProject(cwd);

  return {
    databasePath: expandHome(pickString(env["AGENT_MEMORY_DB"], file.database) ?? join(homedir(), ".agent-memory", "memory.db")),
    project,
    embeddings,
    embeddingUrl,
    embeddingModel: pickString(env["AGENT_MEMORY_EMBEDDING_MODEL"], file.embeddingModel) ?? "text-embedding-3-small",
    embeddingApiKey: pickString(env["AGENT_MEMORY_EMBEDDING_API_KEY"], file.embeddingApiKey) ?? null,
    logLevel: pickEnum(env["AGENT_MEMORY_LOG"], file.logLevel, new Set(LOG_LEVELS), "info", "AGENT_MEMORY_LOG"),
  };
}

function readConfigFile(explicit: string | undefined): FileConfig {
  const path = explicit ? expandHome(explicit) : join(homedir(), ".agent-memory", "config.json");
  if (!existsSync(path)) {
    if (explicit) throw new Error(`Config file not found: ${path}`);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read config ${path}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file ${path} must be a JSON object.`);
  }

  const record = parsed as Record<string, unknown>;
  return {
    database: optionalString(record, "database", path),
    project: record["project"] === null ? null : optionalString(record, "project", path),
    embeddings: optionalEnum(record, "embeddings", EMBEDDING_MODES, path),
    embeddingUrl: optionalString(record, "embeddingUrl", path),
    embeddingModel: optionalString(record, "embeddingModel", path),
    embeddingApiKey: optionalString(record, "embeddingApiKey", path),
    logLevel: optionalEnum(record, "logLevel", new Set(LOG_LEVELS), path),
  };
}

function optionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Config ${path} field "${key}" must be a string.`);
  return value;
}

function optionalEnum<T extends string>(record: Record<string, unknown>, key: string, allowed: Set<T>, path: string): T | undefined {
  const value = optionalString(record, key, path);
  if (value === undefined) return undefined;
  if (!allowed.has(value as T)) {
    throw new Error(`Config ${path} field "${key}" must be one of: ${[...allowed].join(", ")}.`);
  }
  return value as T;
}

function pickString(envValue: string | undefined, fileValue: string | undefined): string | undefined {
  const value = envValue ?? fileValue;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pickEnum<T extends string>(envValue: string | undefined, fileValue: T | undefined, allowed: Set<T>, fallback: T, name: string): T {
  const candidate = envValue?.trim() || fileValue || fallback;
  if (!allowed.has(candidate as T)) {
    throw new Error(`${name} must be one of: ${[...allowed].join(", ")}.`);
  }
  return candidate as T;
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function inferGitProject(cwd: string): string | null {
  let dir = cwd;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, ".git"))) return basename(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
