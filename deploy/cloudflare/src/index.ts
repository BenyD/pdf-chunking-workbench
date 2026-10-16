import { Container, getContainer } from "@cloudflare/containers";

/** The secrets the container needs, set on the Worker with `wrangler secret put`. */
type Env = {
  WORKER: DurableObjectNamespace<ChunklabWorker>;
  DATABASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  STORAGE_BUCKET: string;
  WORKER_SECRET: string;
  ANTHROPIC_API_KEY: string;
  VOYAGE_API_KEY: string;
  VOYAGE_RPM?: string;
  VOYAGE_MAX_TOKENS_PER_REQUEST?: string;
  /** Bump in wrangler.jsonc to start a fresh container, for example after changing a secret: a running container keeps the env it started with. */
  GENERATION?: string;
  /** "true": no generative model at any step; passages as the rules cut them, vectors from the local model baked into the image. */
  PURE?: string;
};

/** One container, kept warm for two hours after its last request, since an ingest runs on in the background. */
export class ChunklabWorker extends Container<Env> {
  defaultPort = 8000;
  sleepAfter = "2h";
  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      DATABASE_URL: env.DATABASE_URL,
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      STORAGE_BUCKET: env.STORAGE_BUCKET,
      WORKER_SECRET: env.WORKER_SECRET,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      VOYAGE_API_KEY: env.VOYAGE_API_KEY,
      VOYAGE_RPM: env.VOYAGE_RPM ?? "60",
      VOYAGE_MAX_TOKENS_PER_REQUEST: env.VOYAGE_MAX_TOKENS_PER_REQUEST ?? "120000",
      PURE: env.PURE ?? "false",
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Every request goes to the same container, so background ingests and the queries about them share a process.
    return getContainer(env.WORKER, `main-${env.GENERATION ?? "1"}`).fetch(request);
  },
} satisfies ExportedHandler<Env>;
