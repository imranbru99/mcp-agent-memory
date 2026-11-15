import type { AppConfig } from "./config.js";
import type { Logger } from "./log.js";
import { tokenize } from "./text.js";

export interface EmbeddingProvider {
  /** Stable id stored beside each vector. Vectors from different ids are never compared. */
  readonly id: string;
  /** Cosine values below this are treated as unrelated for this embedding space. */
  readonly minCosine: number;
  embed(text: string): Promise<Float32Array | null>;
}

const DIM = 256;

const SYNONYMS: Record<string, string> = {
  js: "javascript",
  javascript: "javascript",
  ts: "typescript",
  typescript: "typescript",
  py: "python",
  python: "python",
  postgres: "postgresql",
  postgresql: "postgresql",
  pg: "postgresql",
  k8s: "kubernetes",
  kubernetes: "kubernetes",
  auth: "authentication",
  authentication: "authentication",
  config: "configuration",
  configs: "configuration",
  configuration: "configuration",
  db: "database",
  database: "database",
  doc: "documentation",
  docs: "documentation",
  documentation: "documentation",
  repo: "repository",
  repos: "repository",
  repository: "repository",
  colour: "color",
  color: "color",
  favourite: "favorite",
  favorite: "favorite",
  favorites: "favorite",
  prefer: "preference",
  prefers: "preference",
  preferred: "preference",
  preference: "preference",
  preferences: "preference",
  decide: "decision",
  decided: "decision",
  deciding: "decision",
  decision: "decision",
  decisions: "decision",
};

export function createEmbeddingProvider(config: AppConfig, logger: Logger): EmbeddingProvider {
  if (config.embeddings === "off") return new DisabledEmbedder();
  if (config.embeddings === "http") {
    if (!config.embeddingUrl) {
      throw new Error("HTTP embeddings require AGENT_MEMORY_EMBEDDING_URL.");
    }
    return new HttpEmbedder({
      url: config.embeddingUrl,
      model: config.embeddingModel,
      apiKey: config.embeddingApiKey,
      logger,
    });
  }
  return new LocalHashEmbedder();
}

export class LocalHashEmbedder implements EmbeddingProvider {
  readonly id = "local-hash-v1";
  readonly minCosine = 0.42;

  embed(text: string): Promise<Float32Array | null> {
    return Promise.resolve(hashEmbed(text));
  }
}

export class DisabledEmbedder implements EmbeddingProvider {
  readonly id = "off";
  readonly minCosine = 1;

  embed(): Promise<Float32Array | null> {
    return Promise.resolve(null);
  }
}

export class HttpEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly minCosine = 0.28;
  private readonly url: string;
  private readonly model: string;
  private readonly apiKey: string | null;
  private readonly logger: Logger;

  constructor(options: { url: string; model: string; apiKey: string | null; logger: Logger }) {
    this.url = options.url;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.logger = options.logger;
    this.id = `http:${options.model}`;
  }

  async embed(text: string): Promise<Float32Array | null> {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
      const response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, input: text }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        this.logger.warn("embedding request failed", { status: response.status });
        return null;
      }
      const payload = (await response.json()) as { data?: { embedding?: unknown }[]; embedding?: unknown };
      const raw = payload.data?.[0]?.embedding ?? payload.embedding;
      if (!Array.isArray(raw) || raw.length < 8 || raw.length > 4096) {
        this.logger.warn("embedding response had an unexpected vector");
        return null;
      }
      const vector = new Float32Array(raw.length);
      for (let index = 0; index < raw.length; index += 1) {
        const value = raw[index];
        if (typeof value !== "number" || !Number.isFinite(value)) return null;
        vector[index] = value;
      }
      return l2normalize(vector);
    } catch (error) {
      this.logger.warn("embedding request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export function hashEmbed(text: string): Float32Array {
  const vector = new Float32Array(DIM);
  const tokens = tokenize(text).map(canonical);
  for (const token of tokens) {
    addFeature(vector, token, 3);
    const padded = ` ${token} `;
    for (let index = 0; index < padded.length - 2; index += 1) {
      addFeature(vector, padded.slice(index, index + 3), 0.35);
    }
  }
  return l2normalize(vector);
}

export function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return dot;
}

export function encodeEmbedding(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function decodeEmbedding(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

function canonical(token: string): string {
  const direct = SYNONYMS[token];
  if (direct) return direct;
  const stemmed = stem(token);
  return SYNONYMS[stemmed] ?? stemmed;
}

function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function addFeature(vector: Float32Array, feature: string, weight: number): void {
  const first = fnv(feature);
  const second = fnv(`${feature}#`);
  const dim = vector.length;
  vector[first % dim] = (vector[first % dim] ?? 0) + ((first & 1) === 0 ? weight : -weight);
  vector[second % dim] = (vector[second % dim] ?? 0) + ((second & 1) === 0 ? weight : -weight);
}

function fnv(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function l2normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm;
  }
  return vector;
}
