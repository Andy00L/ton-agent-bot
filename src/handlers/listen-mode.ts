import { InlineKeyboard } from "grammy";
import type { BotContext } from "../context";
import { getState } from "../config";
import { formatTon, shortAddr, escapeHtml } from "../helpers";
import { listenKb, browseIntentsKb, mainMenuKb } from "../keyboards";
import { getUserAgent } from "../services/agent";
import { startListening, stopListening, pollIntents } from "../services/listen";

// ══════════════════════════════════════
// ══ LISTEN MODE CALLBACKS ════════════
// ══════════════════════════════════════
export function registerListenHandlers(botCtx: BotContext) {

  botCtx.bot.callbackQuery("btn_listen", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    if (!state.listenMode) { state.listenMode = true; startListening(botCtx, uid); }
    state.currentMenu = "listening";
    await ctx.editMessageText(
      `<b>👂 Listen Mode ACTIVE</b>\n\nPolling every ${state.pollInterval / 1000}s\nFilter: ${state.listenFilter || "all services"}\n\n${state.lastPollCount} intents tracked`,
      { parse_mode: "HTML", reply_markup: listenKb(0) },
    );
  });

  botCtx.bot.callbackQuery("btn_stop_listen", async (ctx) => {
    await ctx.answerCallbackQuery("Stopped");
    stopListening(ctx.from!.id);
    await ctx.editMessageText(`<b>👂 Listen Mode OFF</b>`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
  });

  botCtx.bot.callbackQuery("btn_show_new", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const userAgent = await getUserAgent(botCtx, ctx.from!.id);
      const result = (await userAgent.runAction("discover_intents", {})) as any;
      const list = (result?.intents || []).slice(0, 5);
      let msg = `<b>📬 Recent Intents</b>\n\n`;
      for (const i of list) {
        const svc = i.serviceName || i.service || "?";
        msg += `<b>#${i.intentIndex} ${escapeHtml(svc)}</b>\n├ 💰 ${i.budget ? formatTon(i.budget) : "?"} TON\n└ 👤 <code>${escapeHtml(shortAddr(i.buyer || ""))}</code>\n\n`;
      }
      await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: browseIntentsKb(list, 0) });
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  botCtx.bot.callbackQuery("btn_listen_random", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const userAgent = await getUserAgent(botCtx, ctx.from!.id);
      const result = (await userAgent.runAction("discover_intents", {})) as any;
      const all = result?.intents || [];
      // Shuffle and take 5
      const shuffled = all.sort(() => Math.random() - 0.5).slice(0, 5);
      let msg = `<b>🎲 Random Intents</b>\n\n`;
      for (const i of shuffled) {
        const svc = i.serviceName || i.service || "?";
        msg += `<b>#${i.intentIndex} ${escapeHtml(svc)}</b>\n├ 💰 ${i.budget ? formatTon(i.budget) : "?"} TON\n└ 👤 <code>${escapeHtml(shortAddr(i.buyer || ""))}</code>\n\n`;
      }
      await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: browseIntentsKb(shuffled, 0) });
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  botCtx.bot.callbackQuery("btn_listen_filter", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.awaitingInput = "listen_filter";
    await ctx.editMessageText(
      `<b>🔍 Listen Filter</b>\n\nCurrent: <b>${state.listenFilter || "all"}</b>\n\nType a service name to filter:\n<i>"price_feed"</i>, <i>"analytics"</i>, or <i>"all"</i> to clear`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Clear Filter", "btn_clear_filter").text("« Back", "btn_listen") },
    );
  });

  botCtx.bot.callbackQuery("btn_clear_filter", async (ctx) => {
    await ctx.answerCallbackQuery("Filter cleared");
    const uid = ctx.from!.id;
    const state = getState(uid);
    state.listenFilter = undefined;
    state.awaitingInput = undefined;
    if (state.listenMode) { stopListening(uid); startListening(botCtx, uid); }
    await ctx.editMessageText(
      `<b>👂 Listen Mode</b>\n\nFilter: <b>all services</b>\n${state.lastPollCount} intents tracked`,
      { parse_mode: "HTML", reply_markup: listenKb(0) },
    );
  });

  botCtx.bot.callbackQuery("btn_poll_now", async (ctx) => {
    await ctx.answerCallbackQuery("Polling...");
    await pollIntents(botCtx, ctx.from!.id);
  });
}
