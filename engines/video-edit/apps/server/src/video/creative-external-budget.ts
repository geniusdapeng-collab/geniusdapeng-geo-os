import { AsyncLocalStorage } from "node:async_hooks";
import { CreativeContractError } from "@hyperreality/video-studio";

export interface CreativeExternalRequest {
  kind: "search" | "media";
  provider: string;
  requestHash: string;
}
interface Hooks {
  shouldAbort(): boolean;
  beforeExternalCall(request: CreativeExternalRequest & { attempt: number }): Promise<string>;
  afterExternalCall(reservation: string, known: boolean): Promise<void>;
}
interface Context {
  hooks: Hooks;
  controller: AbortController;
  tail: Promise<void>;
  sequence: number;
  fatal?: unknown;
}
const storage = new AsyncLocalStorage<Context>();

function assertAvailable(context: Context): void {
  if (context.fatal) throw context.fatal;
  if (context.controller.signal.aborted || context.hooks.shouldAbort()) {
    throw new CreativeContractError("CREATIVE_CANCELLED", "创作已取消或达到墙钟上限");
  }
}

export async function withCreativeExternalBudget<T>(hooks: Hooks, operation: () => Promise<T>): Promise<T> {
  if (storage.getStore()) throw new CreativeContractError("CREATIVE_SCOPE_CONFLICT", "不能嵌套外部请求预算");
  const context: Context = { hooks, controller: new AbortController(), tail: Promise.resolve(), sequence: 0 };
  const timer = setInterval(() => { if (hooks.shouldAbort()) context.controller.abort(); }, 50);
  timer.unref?.();
  try {
    const value = await storage.run(context, operation);
    await context.tail;
    assertAvailable(context);
    return value;
  } finally {
    context.controller.abort();
    clearInterval(timer);
    await context.tail;
  }
}

/** Serializing paid requests prevents queued work from dispatching after an unknown result. */
export function guardedCreativeExternalCall<T>(
  request: CreativeExternalRequest, operation: (signal?: AbortSignal) => Promise<T>, isKnown: (value: T) => boolean,
): Promise<T> {
  const context = storage.getStore();
  if (!context) return operation();
  const dispatch = context.tail.then(async () => {
    assertAvailable(context);
    const reservation = await context.hooks.beforeExternalCall({ ...request, attempt: ++context.sequence });
    let known = false, result: T;
    try {
      assertAvailable(context);
      result = await operation(context.controller.signal);
      known = isKnown(result);
    } catch (error) {
      await context.hooks.afterExternalCall(reservation, false);
      throw new CreativeContractError("CREATIVE_USAGE_UNKNOWN", "外部请求结果未知，保留费用预留");
    }
    await context.hooks.afterExternalCall(reservation, known);
    if (!known) throw new CreativeContractError("CREATIVE_USAGE_UNKNOWN", "外部请求回执未验证，保留费用预留");
    assertAvailable(context);
    return result;
  });
  context.tail = dispatch.then(() => undefined, error => { context.fatal = error; });
  return dispatch;
}
