import type { BotContext } from "../context";
import { getState } from "../config";
import { mainMenuKb, autoModeKb } from "../keyboards";
import { verboseLog } from "../helpers";

// ══════════════════════════════════════
// ══ AUTO MODE CALLBACKS ══════════════
// ══════════════════════════════════════
export function registerAutoHandlers(botCtx: BotContext) {

  botCtx.bot.callbackQuery("btn_auto", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    if (!state.autoMode) state.autoMode = true;
    verboseLog(`USER:${uid}`, "MODE_CHANGE", "→ auto");
    state.currentMenu = "auto";
    await ctx.editMessageText(
      `<b>🤖 Auto Mode ACTIVE</b>\n\nSend me a mission. I'll handle everything.\n\n<i>"Find a cheap price feed and buy it"</i>\n<i>"Register as analytics provider"</i>\n<i>"Check all intents and offer on the best ones"</i>`,
      { parse_mode: "HTML", reply_markup: autoModeKb(state) },
    );
  });

  botCtx.bot.callbackQuery("btn_stop_auto", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery: Stopped");
    await ctx.answerCallbackQuery("Stopped");
    const state = getState(ctx.from!.id);
    state.autoMode = false;
    state.autoRunning = false;
    verboseLog(`USER:${ctx.from?.id}`, "MODE_CHANGE", "→ normal");
    await ctx.editMessageText(`<b>🤖 Auto Mode OFF</b>`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
  });
}
