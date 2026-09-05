import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ADMIN_EMAIL: z.string().email(),
  // Optional: when absent, the password is set once through the first-run screen
  // and stored as a bcrypt hash in the settings table.
  ADMIN_PASSWORD_HASH: z.string().optional().default(""),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 chars"),

  ANTHROPIC_API_KEY: z.string().optional().default(""),
  CLAUDE_MODEL_FRONTIER: z.string().default("claude-sonnet-4-5"),
  CLAUDE_MODEL_CHEAP: z.string().default("claude-haiku-4-5"),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(50),

  SHOPIFY_STORE_DOMAIN: z.string().optional().default(""),
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().optional().default(""),
  SHOPIFY_API_SECRET: z.string().optional().default(""),
  SHOPIFY_API_VERSION: z.string().default("2025-07"),

  APP_URL: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

let cached: z.infer<typeof schema> | null = null;

export function env(): z.infer<typeof schema> {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  }
  cached = parsed.data;
  return cached;
}
