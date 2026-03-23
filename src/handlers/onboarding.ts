import { InlineKeyboard } from "grammy";
import OpenAI from "openai";
import { mnemonicNew } from "@ton/crypto";
import { KeypairWallet } from "@ton-agent-kit/core";
import { LLM_PROVIDERS } from "@ton-agent-kit/wallet-store";
import type { BotContext } from "../context";
import { NETWORK, getState } from "../config";
import { formatTon, escapeHtml, friendlyAddr, verboseLog } from "../helpers";
import { mainMenuKb } from "../keyboards";
import { getUserAgent } from "../services/agent";

// ── Onboarding helper ──
async function showOnboarding(botCtx: BotContext, ctx: any, uid: number, edit = false) {
  const hasW = botCtx.secretStore.hasWallet(uid);
  const hasA = botCtx.secretStore.hasApiKey(uid);
  const kb = new InlineKeyboard();
  if (!hasW) {
    kb.text("🔑 Generate new wallet", "setup_wallet_generate").row();
    kb.text("📥 Import mnemonic", "setup_wallet_import").row();
  }
  if (!hasA) {
    kb.text("🧠 Set up AI key", "setup_ai_provider").row();
  }
  kb.text("⏭️ Skip for now", "setup_skip");
  let msg = `<b>🤖 TON Agent Kit</b>\n\n`;
  msg += `<b>Step 1: Wallet</b> ${hasW ? "✅" : "⬜"}\nTransfer, trade, escrow, sell services\n\n`;
  msg += `<b>Step 2: AI Key</b> ${hasA ? "✅" : "⬜"}\nChat, auto mode, complex commands\n\n`;
  msg += `<i>Without wallet:</i> read-only (browse prices, agents, intents)\n`;
  msg += `<i>Without AI key:</i> buttons work, chat does not`;
  if (edit) {
    await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: kb });
  } else {
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "showOnboarding");
    await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
  }
}

// ══════════════════════════════════════
// ══ /start COMMAND + ONBOARDING ══════
// ══════════════════════════════════════
export function registerOnboardingHandlers(botCtx: BotContext) {
  botCtx.bot.command("start", async (ctx) => {
    const uid = ctx.from!.id;
    const state = getState(uid);
    const hasW = botCtx.secretStore.hasWallet(uid);
    const hasA = botCtx.secretStore.hasApiKey(uid);

    if (hasW && hasA) {
      // Returning user — show main menu with their balance
      state.walletReady = true;
      state.aiReady = true;
      const userAgent = await getUserAgent(botCtx, uid);
      const walletAddr = friendlyAddr(botCtx.secretStore.getWalletAddress(uid)!, NETWORK === "testnet");
      let bal = "?";
      try { bal = formatTon(((await userAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
      verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "start command: returning user main menu");
      const sent = await ctx.reply(
        `<b>🤖 TON Agent Kit</b>\n\n` +
        `<code>${escapeHtml(walletAddr)}</code> <i>(tap to copy)</i>\n` +
        `Balance: <b>${bal} TON</b> · ${NETWORK}\n\n` +
        `⚡ ${userAgent.getAvailableActions().length} actions · x402: ${botCtx.publicUrl}\n\n` +
        `Tap any button below.`,
        { parse_mode: "HTML", reply_markup: mainMenuKb() },
      );
      state.mainMessageId = sent.message_id;
      state.currentMenu = "main";
    } else {
      await showOnboarding(botCtx, ctx, uid);
    }
  });

  // ══════════════════════════════════════
  // ══ ONBOARDING CALLBACKS ═════════════
  // ══════════════════════════════════════

  botCtx.bot.callbackQuery("setup_wallet_generate", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    try {
      const words = await mnemonicNew(24);
      const wallet = await KeypairWallet.fromMnemonic(words, { network: NETWORK, version: "V5R1" });
      const addr = wallet.address.toRawString();
      botCtx.secretStore.saveWallet(uid, words.join(" "), addr);
      getState(uid).walletReady = true;
      botCtx.userAgents.delete(uid);

      // Format 24 words in 8 rows of 3 with monospace alignment
      let grid = "";
      for (let i = 0; i < 24; i += 3) {
        const row = words.slice(i, i + 3).map((w, j) => {
          const num = String(i + j + 1).padStart(2, " ");
          return `${num}. ${w.padEnd(10)}`;
        }).join("");
        grid += (grid ? "\n" : "") + row;
      }
      const mnemonicMsg = await ctx.editMessageText(
        `<b>🔑 Your wallet is ready!</b>\n\n` +
        `<b>Save these 24 words securely:</b>\n\n` +
        `<pre>${escapeHtml(grid)}</pre>\n\n` +
        `⚠️ <b>This is the ONLY time you'll see them.</b>\nAnyone with these words can access your funds.\n\n` +
        `<i>Auto-deletes in 30 seconds.</i>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✅ I saved them", "setup_wallet_saved") },
      );
      setTimeout(async () => {
        try { await botCtx.bot.api.deleteMessage(ctx.chat!.id, mnemonicMsg.message_id); } catch {}
      }, 30000);
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ Failed to generate wallet: ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Try again", "setup_wallet_generate").text("« Back", "setup_back") });
    }
  });

  botCtx.bot.callbackQuery("setup_wallet_saved", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    try { await ctx.deleteMessage(); } catch {}
    const addr = botCtx.secretStore.getWalletAddress(uid);
    const kb = new InlineKeyboard();
    if (!botCtx.secretStore.hasApiKey(uid)) kb.text("🧠 Set up AI key", "setup_ai_provider").row();
    kb.text("🏠 Main menu", "btn_main");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "wallet saved confirmation");
    await ctx.reply(
      `<b>✅ Wallet saved!</b>\n\n📍 <code>${escapeHtml(friendlyAddr(addr || "?", NETWORK === "testnet"))}</code>\n🌐 ${NETWORK}\n\n<i>Send ${NETWORK === "testnet" ? "testnet" : ""} TON to this address to start.</i>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  botCtx.bot.callbackQuery("setup_wallet_import", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    state.awaitingMnemonic = true;
    await ctx.editMessageText(
      `<b>📥 Import Wallet</b>\n\nSend me your 24-word mnemonic.\n\n⚠️ <b>Your message will be deleted immediately.</b>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Cancel", "setup_back") },
    );
  });

  botCtx.bot.callbackQuery("setup_ai_provider", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    for (const [key, p] of Object.entries(LLM_PROVIDERS)) {
      kb.text(p.name, `setup_ai_key_${key}`).row();
    }
    kb.text("« Back", "setup_back");
    await ctx.editMessageText(
      `<b>🧠 Choose AI Provider</b>\n\nAll providers use OpenAI-compatible API.\nYou bring your own key — the bot operator pays $0.\n\n<i>Pick one:</i>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  for (const [providerKey, provider] of Object.entries(LLM_PROVIDERS)) {
    botCtx.bot.callbackQuery(`setup_ai_key_${providerKey}`, async (ctx) => {
      verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
      verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
      await ctx.answerCallbackQuery();
      const uid = ctx.from!.id;
      const state = getState(uid);
      state.awaitingApiKey = true;
      state.pendingProvider = providerKey;
      await ctx.editMessageText(
        `<b>🧠 ${escapeHtml(provider.name)}</b>\n\n` +
        `Get your API key: ${provider.keyUrl}\n\n` +
        `<b>Send me your API key.</b>\n⚠️ Your message will be deleted immediately.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Cancel", "setup_ai_provider") },
      );
    });
  }

  botCtx.bot.callbackQuery(/^setup_ai_model_([a-z]+)_(.+)$/, async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery: Validating...");
    await ctx.answerCallbackQuery("Validating...");
    const uid = ctx.from!.id;
    const state = getState(uid);
    const providerKey = ctx.match![1];
    const modelId = ctx.match![2];
    const apiKey = (state as any)._tempApiKey;
    if (!apiKey) {
      await ctx.editMessageText(`⚠️ Session expired. Please start over.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Set up AI key", "setup_ai_provider") });
      return;
    }
    const provider = LLM_PROVIDERS[providerKey];
    try {
      const testClient = new OpenAI({ apiKey, baseURL: provider?.baseURL });
      await testClient.chat.completions.create({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
      // Success
      botCtx.secretStore.saveApiKey(uid, providerKey, modelId, apiKey);
      delete (state as any)._tempApiKey;
      state.pendingProvider = undefined;
      state.aiReady = true;
      botCtx.userOpenAIClients.delete(uid);
      botCtx.chatHistories.delete(ctx.chat!.id);
      const kb = new InlineKeyboard();
      if (!botCtx.secretStore.hasWallet(uid)) kb.text("🔑 Set up wallet", "setup_wallet_generate").row();
      kb.text("🏠 Main menu", "btn_main");
      await ctx.editMessageText(
        `<b>✅ AI configured!</b>\n\n🧠 Provider: <b>${escapeHtml(provider?.name || providerKey)}</b>\n🤖 Model: <b>${escapeHtml(modelId)}</b>`,
        { parse_mode: "HTML", reply_markup: kb },
      );
    } catch (err: any) {
      const status = err?.status || err?.response?.status;
      let hint = err.message?.slice(0, 200) || "Unknown error";
      if (status === 401) hint = "Invalid API key";
      else if (status === 403) hint = "No access to this model";
      else if (status === 404) hint = `Model not found: ${modelId}`;
      else if (status === 429) hint = "Rate limited. Wait and try again";
      await ctx.editMessageText(
        `<b>❌ Validation failed</b>\n\n${escapeHtml(hint)}\n\n<i>Try again or pick a different model.</i>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🔄 Try again", `setup_ai_key_${providerKey}`).text("« Providers", "setup_ai_provider") },
      );
    }
  });

  botCtx.bot.callbackQuery("setup_skip", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    state.currentMenu = "main";
    let bal = "?";
    try { bal = formatTon(((await botCtx.readOnlyAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
    await ctx.editMessageText(
      `<b>🤖 TON Agent Kit</b>\n\n` +
      `Balance: <b>${bal} TON</b> · ${NETWORK}\n\n` +
      `<i>Some features need a wallet and AI key.\nSet them up anytime in Settings.</i>`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  botCtx.bot.callbackQuery("setup_back", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    state.awaitingMnemonic = false;
    state.awaitingApiKey = false;
    state.pendingProvider = undefined;
    delete (state as any)._tempApiKey;
    await showOnboarding(botCtx, ctx, uid, true);
  });
}
