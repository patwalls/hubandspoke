/**
 * Server-only half of metered.ts: the writer that inserts one `llm_calls` row
 * per model call. Installed once per process at boot — src/instrumentation.ts
 * (web, Node runtime) and src/jobs/worker.ts (worker). Never import this from
 * a module a client component can reach; that is why it is separate.
 */
import { db } from "@/lib/db";
import { llmCalls } from "@/lib/db/schema";
import { setLlmCallRecorder, type RecordFn } from "./metered";

export const recordLlmCall: RecordFn = async (provider, feature, usage) => {
  await db.insert(llmCalls).values({ provider, feature, ...usage });
};

export function installLlmCallRecorder(): void {
  setLlmCallRecorder(recordLlmCall);
}
