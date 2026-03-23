import { InlineKeyboard } from "grammy";
import { LLM_PROVIDERS } from "@ton-agent-kit/wallet-store";
import type { BotContext } from "../context";
import { NETWORK, getState } from "../config";
import { formatTon, escapeHtml, friendlyAddr, verboseLog } from "../helpers";
import { settingsKb, mainMenuKb } from "../keyboards";
import { getUserAgent } from "../services/agent";
import { startListening, stopListening } from "../services/listen";

// ══════════════════════════════════════
// ══ SETTINGS CALLBACKS ═══════════════
// ══════════════════════════════════════
export function registerSettingsHandlers(botCtx: BotContext) {

  botCtx.bot.callbackQuery("btn_settings", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.currentMenu = "settings";
    await ctx.editMessageText(`<b>⚙️ Settings</b>\n\nConfigure your agent behavior.`, { parse_mode: "HTML", reply_markup: settingsKb(state) });
  });

  botCtx.bot.callbackQuery("toggle_confirm", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.confirmTrades = !state.confirmTrades;
    await ctx.editMessageText(
      `<b>⚙️ Settings</b>\n\nConfirm Trades: <b>${state.confirmTrades ? "ON" : "OFF"}</b>\n<i>${state.confirmTrades ? "Transfers need approval" : "No approval buttons"}</i>`,
      { parse_mode: "HTML", reply_markup: settingsKb(state) },
    );
  });

  botCtx.bot.callbackQuery("toggle_auto", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.autoMode = !state.autoMode;
    if (!state.autoMode) state.autoRunning = false;
    verboseLog(`USER:${ctx.from?.id}`, "MODE_CHANGE", state.autoMode ? "→ auto" : "→ normal");
    await ctx.editMessageText(
      `<b>⚙️ Settings</b>\n\nAuto Mode: <b>${state.autoMode ? "ON" : "OFF"}</b>`,
      { parse_mode: "HTML", reply_markup: settingsKb(state) },
    );
  });

  botCtx.bot.callbackQuery("toggle_listen", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    state.listenMode = !state.listenMode;
    if (state.listenMode) startListening(botCtx, uid); else stopListening(uid);
    verboseLog(`USER:${uid}`, "MODE_CHANGE", state.listenMode ? "→ listen" : "→ normal");
    await ctx.editMessageText(
      `<b>⚙️ Settings</b>\n\nListen Mode: <b>${state.listenMode ? "ON" : "OFF"}</b>`,
      { parse_mode: "HTML", reply_markup: settingsKb(state) },
    );
  });

  botCtx.bot.callbackQuery("cycle_hitl", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    const vals = [0.05, 0.1, 0.5, 1.0];
    const idx = vals.indexOf(state.hitlThreshold);
    state.hitlThreshold = vals[(idx + 1) % vals.length];
    await ctx.editMessageText(`<b>⚙️ Settings</b>\n\nHITL threshold: <b>${state.hitlThreshold} TON</b>`, { parse_mode: "HTML", reply_markup: settingsKb(state) });
  });

  botCtx.bot.callbackQuery("cycle_steps", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    const vals = [5, 10, 15, 20];
    const idx = vals.indexOf(state.maxAutoSteps);
    state.maxAutoSteps = vals[(idx + 1) % vals.length];
    await ctx.editMessageText(`<b>⚙️ Settings</b>\n\nMax auto steps: <b>${state.maxAutoSteps}</b>`, { parse_mode: "HTML", reply_markup: settingsKb(state) });
  });

  botCtx.bot.callbackQuery("cycle_poll", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    const vals = [15000, 30000, 60000];
    const idx = vals.indexOf(state.pollInterval);
    state.pollInterval = vals[(idx + 1) % vals.length];
    if (state.listenMode) { stopListening(uid); startListening(botCtx, uid); }
    await ctx.editMessageText(`<b>⚙️ Settings</b>\n\nPoll interval: <b>${state.pollInterval / 1000}s</b>`, { parse_mode: "HTML", reply_markup: settingsKb(state) });
  });

  // ══════════════════════════════════════
  // ══ WALLET SETTINGS CALLBACKS ════════
  // ══════════════════════════════════════

  botCtx.bot.callbackQuery("settings_wallet", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    if (botCtx.secretStore.hasWallet(uid)) {
      const addr = friendlyAddr(botCtx.secretStore.getWalletAddress(uid)!, NETWORK === "testnet");
      const userAgent = await getUserAgent(botCtx, uid);
      let bal = "?";
      try { bal = formatTon(((await userAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
      await ctx.editMessageText(
        `<b>💰 Wallet</b>\n\n📍 <code>${escapeHtml(addr)}</code>\n💰 <b>${bal} TON</b>\n🌐 ${NETWORK}`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard()
          .text("📤 Export mnemonic", "wallet_export").text("🔄 Change wallet", "wallet_change").row()
          .text("🗑️ Disconnect", "wallet_disconnect").text("« Back", "btn_settings") },
      );
    } else {
      await ctx.editMessageText(
        `<b>💰 Wallet</b>\n\n<i>No wallet configured.</i>\nSet up a wallet to use on-chain features.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard()
          .text("🔑 Generate new", "setup_wallet_generate").text("📥 Import", "setup_wallet_import").row()
          .text("« Back", "btn_settings") },
      );
    }
  });

  botCtx.bot.callbackQuery("wallet_export", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>⚠️ Export mnemonic?</b>\n\nYour 24-word mnemonic will be shown.\nThe message will be auto-deleted in 30 seconds.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✅ Show mnemonic", "wallet_export_confirm").text("« Cancel", "settings_wallet") },
    );
  });

  botCtx.bot.callbackQuery("wallet_export_confirm", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const stored = botCtx.secretStore.loadWallet(uid);
    if (!stored) {
      await ctx.editMessageText(`⚠️ No wallet found.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Back", "settings_wallet") });
      return;
    }
    const words = stored.mnemonic.split(" ");
    let grid = "";
    for (let i = 0; i < words.length; i += 3) {
      const row = words.slice(i, i + 3).map((w, j) => {
        const num = String(i + j + 1).padStart(2, " ");
        return `${num}. ${w.padEnd(10)}`;
      }).join("");
      grid += (grid ? "\n" : "") + row;
    }
    const msg = await ctx.editMessageText(
      `<b>🔑 Your mnemonic</b>\n\n<pre>${escapeHtml(grid)}</pre>\n\n⚠️ <b>This message will be deleted in 30 seconds.</b>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🗑️ Delete now", "settings_wallet") },
    );
    setTimeout(async () => {
      try { await botCtx.bot.api.deleteMessage(ctx.chat!.id, msg.message_id); } catch {}
    }, 30000);
  });

  botCtx.bot.callbackQuery("wallet_change", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>🔄 Change Wallet</b>\n\nThis will replace your current wallet.\nMake sure you've backed up your mnemonic.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard()
        .text("🔑 Generate new", "setup_wallet_generate").text("📥 Import", "setup_wallet_import").row()
        .text("« Cancel", "settings_wallet") },
    );
  });

  botCtx.bot.callbackQuery("wallet_disconnect", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>⚠️ Disconnect wallet?</b>\n\nYou will lose access to your wallet unless you have the mnemonic backed up.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🗑️ Yes, disconnect", "wallet_disconnect_confirm").text("« Cancel", "settings_wallet") },
    );
  });

  botCtx.bot.callbackQuery("wallet_disconnect_confirm", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    botCtx.secretStore.deleteWallet(uid);
    botCtx.userAgents.delete(uid);
    getState(uid).walletReady = false;
    botCtx.chatHistories.delete(ctx.chat!.id);
    await ctx.editMessageText(
      `<b>✅ Wallet disconnected.</b>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🔑 Set up new wallet", "settings_wallet").text("« Back", "btn_settings") },
    );
  });

  // ══════════════════════════════════════
  // ══ AI SETTINGS CALLBACKS ════════════
  // ══════════════════════════════════════

  botCtx.bot.callbackQuery("settings_ai", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    if (botCtx.secretStore.hasApiKey(uid)) {
      const info = botCtx.secretStore.getApiKeyInfo(uid)!;
      const providerName = LLM_PROVIDERS[info.provider]?.name || info.provider;
      await ctx.editMessageText(
        `<b>🧠 AI Provider</b>\n\n🏢 Provider: <b>${escapeHtml(providerName)}</b>\n🤖 Model: <b>${escapeHtml(info.model)}</b>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard()
          .text("🔄 Change provider", "setup_ai_provider").row()
          .text("🗑️ Remove key", "ai_remove").text("« Back", "btn_settings") },
      );
    } else {
      await ctx.editMessageText(
        `<b>🧠 AI Provider</b>\n\n<i>No AI key configured.</i>\nSet up an AI key to use chat and auto mode.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard()
          .text("🧠 Set up AI key", "setup_ai_provider").text("« Back", "btn_settings") },
      );
    }
  });

  botCtx.bot.callbackQuery("ai_remove", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>⚠️ Remove AI key?</b>\n\nYou won't be able to use chat or auto mode.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🗑️ Yes, remove", "ai_remove_confirm").text("« Cancel", "settings_ai") },
    );
  });

  botCtx.bot.callbackQuery("ai_remove_confirm", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    botCtx.secretStore.deleteApiKey(uid);
    botCtx.userOpenAIClients.delete(uid);
    getState(uid).aiReady = false;
    botCtx.chatHistories.delete(ctx.chat!.id);
    await ctx.editMessageText(
      `<b>✅ AI key removed.</b>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🧠 Set up AI key", "setup_ai_provider").text("« Back", "btn_settings") },
    );
  });
}
