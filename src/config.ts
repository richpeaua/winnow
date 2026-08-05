// G1 config + secrets. No inline secrets: values support ${ENV} interpolation.
// zod-validated, fail-fast. Transport-from-config wiring (stdio/http) is the
// one marked stub in this skeleton — see buildUpstreams.
import { z } from "zod";
import type { UpstreamConnection } from "./upstream/types.ts";

const FilterPolicy = z.object({
  project: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  truncate: z.enum(["head", "tail", "smart"]).optional(),
  paginate: z.boolean().optional(),
});

const HttpAuth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer"), token: z.string() }),
  z.object({ type: z.literal("oauth"), tokens: z.string() }),
  z.object({ type: z.literal("client_credentials"), clientId: z.string(), clientSecret: z.string(), tokenUrl: z.string() }),
]);

const ServerConfig = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    tools: z.record(z.string(), FilterPolicy).optional(),
  }),
  z.object({
    transport: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    auth: HttpAuth.optional(),
    tools: z.record(z.string(), FilterPolicy).optional(),
  }),
]);

export const McpClientConfigSchema = z.object({
  servers: z.record(z.string(), ServerConfig),
  cache: z.boolean().default(true),
  defaults: z.object({ maxTokens: z.number().int().positive().default(2000) }).default({ maxTokens: 2000 }),
  search: z.object({ topK: z.number().int().positive().default(8) }).default({ topK: 8 }),
});

export type McpClientConfig = z.infer<typeof McpClientConfigSchema>;

/** Replace ${ENV_VAR} in every string with process.env; fail if a referenced var is missing. */
export function interpolateEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => {
      const v = env[name];
      if (v === undefined) throw new Error(`config references missing env var: ${name}`);
      return v;
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env)])) as T;
  }
  return value;
}

/** Parse + validate (fail-fast) + interpolate secrets. */
export function resolveConfig(raw: unknown): McpClientConfig {
  const interpolated = interpolateEnv(raw);
  return McpClientConfigSchema.parse(interpolated);
}

/**
 * STUB: build real upstream connections from config transports.
 * The validated core runs on injected upstreams (see McpClient/MockUpstream);
 * real stdio/http wiring via @modelcontextprotocol/sdk lands here next.
 */
export function buildUpstreams(_config: McpClientConfig): UpstreamConnection[] {
  throw new Error(
    "buildUpstreams: real stdio/http transport wiring not implemented in the skeleton. " +
    "Inject upstreams directly (new McpClient({ upstreams })) or add a stdio adapter in src/upstream/."
  );
}
