import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRuns, llmUsageDaily } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { withRetry, rateLimit } from "@/lib/ratelimit";
import type { Scope } from "@/lib/db/scoped";

/* Per-million-token USD pricing, used only for budget accounting. Adjust here
   if Anthropic pricing changes; nothing else reads these numbers. */
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-opus-4-5": { in: 5, out: 25 },
};

function priceFor(model: string) {
  const key = Object.keys(PRICING).find((k) => model.startsWith(k));
  return PRICING[key ?? ""] ?? { in: 3, out: 15 };
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  return client;
}

export class BudgetExceededError extends Error {}
export class AiDisabledError extends Error {}
export class SchemaValidationError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
  }
}

/** Month-to-date AI spend in USD. */
export async function monthToDateSpendUsd(storeId: string): Promise<number> {
  const first = new Date();
  first.setUTCDate(1);
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${llmUsageDaily.costCents}), 0)` })
    .from(llmUsageDaily)
    .where(
      and(
        eq(llmUsageDaily.storeId, storeId),
        gte(llmUsageDaily.usageDate, first.toISOString().slice(0, 10)),
      ),
    );
  return Number(rows[0]?.total ?? 0) / 100;
}

export type GenerateOptions<T extends z.ZodTypeAny> = {
  scope: Scope;
  agentName: string;
  tier?: "cheap" | "frontier";
  system: string;
  /** Untrusted content must already be wrapped with untrustedBlock(). */
  prompt: string;
  schema: T;
  maxTokens?: number;
  temperature?: number;
  promptVersion?: string;
  inputRefs?: Record<string, unknown>;
};

export type GenerateResult<T> = {
  data: T;
  agentRunId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
};

/**
 * The only way this application talks to Claude.
 *
 * Guarantees, in order:
 *  1. Budget breaker checked before the call. Exceeding the ceiling disables
 *     agent invocation and nothing else - ingestion, dashboards and deterministic
 *     scoring keep working.
 *  2. Output is parsed as JSON and validated with Zod. One repair attempt, then
 *     it fails to human review. Free-form model text never leaves this function.
 *  3. Every run is written to agent_runs with tokens, cost and latency.
 *  4. The returned value is DATA. It cannot reach an external system except by
 *     being proposed into the approval queue and approved by a human.
 */
export async function generateStructured<T extends z.ZodTypeAny>(
  opts: GenerateOptions<T>,
): Promise<GenerateResult<z.infer<T>>> {
  const cfg = env();
  if (!cfg.ANTHROPIC_API_KEY) {
    throw new AiDisabledError("ANTHROPIC_API_KEY is not set. Add it to .env to enable AI features.");
  }

  const limit = rateLimit(`claude:${opts.scope.storeId}`, { capacity: 8, refillPerSecond: 0.5 });
  if (!limit.ok) throw new Error(`Rate limited. Retry in ${Math.ceil(limit.retryAfterMs / 1000)}s.`);

  const spend = await monthToDateSpendUsd(opts.scope.storeId);
  if (spend >= cfg.AI_MONTHLY_BUDGET_USD) {
    throw new BudgetExceededError(
      `Monthly AI budget of $${cfg.AI_MONTHLY_BUDGET_USD} reached ($${spend.toFixed(2)} spent). ` +
        `Raise AI_MONTHLY_BUDGET_USD or wait for the next month. Monitoring is unaffected.`,
    );
  }

  const tier = opts.tier ?? "frontier";
  const model = tier === "cheap" ? cfg.CLAUDE_MODEL_CHEAP : cfg.CLAUDE_MODEL_FRONTIER;
  const started = Date.now();

  const jsonSystem =
    `${opts.system}\n\n` +
    `OUTPUT CONTRACT\n` +
    `Respond with a single JSON object and nothing else. No prose, no markdown fence.\n` +
    `Never invent a fact. Where you do not have evidence, use the provided null/"missing" ` +
    `option and mark provenance as "estimated" or "missing". A confident guess presented as ` +
    `fact is a failure; an honest gap is not.`;

  let inputTokens = 0;
  let outputTokens = 0;
  let repairAttempted = false;
  let rawText = "";

  const call = async (messages: Anthropic.MessageParam[]) => {
    const res = await withRetry(
      () =>
        anthropic().messages.create({
          model,
          max_tokens: opts.maxTokens ?? 8000,
          temperature: opts.temperature ?? 0.4,
          system: jsonSystem,
          messages,
        }),
      { attempts: 3, label: opts.agentName },
    );
    inputTokens += res.usage.input_tokens;
    outputTokens += res.usage.output_tokens;
    const block = res.content.find((c) => c.type === "text");
    return block && block.type === "text" ? block.text : "";
  };

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.prompt }];

  let parsed: z.infer<T> | null = null;
  let failure = "";

  try {
    rawText = await call(messages);
    const first = tryParse(opts.schema, rawText);
    if (first.ok) {
      parsed = first.data;
    } else {
      repairAttempted = true;
      failure = first.error;
      messages.push({ role: "assistant", content: rawText });
      messages.push({
        role: "user",
        content:
          `Your previous response did not satisfy the schema. Validation errors:\n${first.error}\n\n` +
          `Return the corrected JSON object only. Do not explain.`,
      });
      rawText = await call(messages);
      const second = tryParse(opts.schema, rawText);
      if (second.ok) parsed = second.data;
      else failure = second.error;
    }
  } catch (err) {
    await recordRun({
      opts,
      model,
      tier,
      status: "failed",
      inputTokens,
      outputTokens,
      startedAt: started,
      schemaValid: false,
      repairAttempted,
      error: err instanceof Error ? err.message : String(err),
      output: null,
    });
    throw err;
  }

  const costUsd = usd(model, inputTokens, outputTokens);

  if (!parsed) {
    const runId = await recordRun({
      opts,
      model,
      tier,
      status: "needs_human_review",
      inputTokens,
      outputTokens,
      startedAt: started,
      schemaValid: false,
      repairAttempted,
      error: failure,
      output: { raw: rawText.slice(0, 20000) },
    });
    log.warn("claude output failed schema validation", { agentRunId: runId, agent: opts.agentName });
    throw new SchemaValidationError(
      `${opts.agentName} returned output that failed validation after one repair attempt. Sent to human review.`,
      rawText,
    );
  }

  const agentRunId = await recordRun({
    opts,
    model,
    tier,
    status: "completed",
    inputTokens,
    outputTokens,
    startedAt: started,
    schemaValid: true,
    repairAttempted,
    error: null,
    output: parsed as unknown as Record<string, unknown>,
  });

  return { data: parsed, agentRunId, costUsd, inputTokens, outputTokens };
}

function tryParse<T extends z.ZodTypeAny>(
  schema: T,
  text: string,
): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return { ok: false, error: "Response contained no JSON object." };

  let json: unknown;
  try {
    json = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }

  const result = schema.safeParse(json);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    error: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
  };
}

function usd(model: string, inTok: number, outTok: number): number {
  const p = priceFor(model);
  return (inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out;
}

async function recordRun(args: {
  opts: GenerateOptions<z.ZodTypeAny>;
  model: string;
  tier: "cheap" | "frontier";
  status: "completed" | "needs_human_review" | "blocked" | "failed";
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  schemaValid: boolean;
  repairAttempted: boolean;
  error: string | null;
  output: unknown;
}): Promise<string> {
  const costCents = usd(args.model, args.inputTokens, args.outputTokens) * 100;
  const [row] = await db
    .insert(agentRuns)
    .values({
      storeId: args.opts.scope.storeId,
      agentName: args.opts.agentName,
      model: args.model,
      modelTier: args.tier,
      promptVersion: args.opts.promptVersion ?? "v1",
      inputRefs: (args.opts.inputRefs ?? null) as never,
      output: (args.output ?? null) as never,
      status: args.status,
      schemaValid: args.schemaValid,
      repairAttempted: args.repairAttempted,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costCents: costCents.toFixed(4),
      latencyMs: Date.now() - args.startedAt,
      error: args.error,
      completedAt: new Date(),
    })
    .returning({ id: agentRuns.id });

  const today = new Date().toISOString().slice(0, 10);
  await db
    .insert(llmUsageDaily)
    .values({
      storeId: args.opts.scope.storeId,
      usageDate: today,
      agentName: args.opts.agentName,
      model: args.model,
      runs: 1,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costCents: costCents.toFixed(4),
    })
    .onConflictDoUpdate({
      target: [
        llmUsageDaily.storeId,
        llmUsageDaily.usageDate,
        llmUsageDaily.agentName,
        llmUsageDaily.model,
      ],
      set: {
        runs: sql`${llmUsageDaily.runs} + 1`,
        inputTokens: sql`${llmUsageDaily.inputTokens} + ${args.inputTokens}`,
        outputTokens: sql`${llmUsageDaily.outputTokens} + ${args.outputTokens}`,
        costCents: sql`${llmUsageDaily.costCents} + ${costCents.toFixed(4)}`,
      },
    });

  return row!.id;
}
