import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";

const TELEGRAM_CALLBACK_QUERY_ACK_ATTEMPTED_KEY = "__openclawTelegramCallbackQueryAckAttempted";

type TelegramCallbackQueryAckContext = {
  callbackQuery?: { id?: string };
  answerCallbackQuery?: unknown;
  [TELEGRAM_CALLBACK_QUERY_ACK_ATTEMPTED_KEY]?: boolean;
};

export async function answerTelegramCallbackQueryOnce(params: {
  ctx: TelegramCallbackQueryAckContext;
  runtime?: RuntimeEnv;
  answerById: (callbackId: string) => Promise<unknown>;
}): Promise<void> {
  const callbackId = params.ctx.callbackQuery?.id;
  if (!callbackId || params.ctx[TELEGRAM_CALLBACK_QUERY_ACK_ATTEMPTED_KEY]) {
    return;
  }
  params.ctx[TELEGRAM_CALLBACK_QUERY_ACK_ATTEMPTED_KEY] = true;
  const ctxAnswerCallbackQuery = params.ctx.answerCallbackQuery;
  const answerCallbackQuery =
    typeof ctxAnswerCallbackQuery === "function"
      ? () => Promise.resolve(ctxAnswerCallbackQuery.call(params.ctx))
      : () => params.answerById(callbackId);
  await withTelegramApiErrorLogging({
    operation: "answerCallbackQuery",
    runtime: params.runtime,
    fn: answerCallbackQuery,
  }).catch(() => {});
}
