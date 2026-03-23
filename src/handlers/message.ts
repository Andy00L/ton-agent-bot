import { InlineKeyboard } from "grammy";
import OpenAI from "openai";
import { KeypairWallet } from "@ton-agent-kit/core";
import { LLM_PROVIDERS } from "@ton-agent-kit/wallet-store";
import type { BotContext } from "../context";
import { NETWORK, AUTO_APPROVE_LIMIT, getState } from "../config";
import { escapeHtml, safeReply } from "../helpers";
import { offerFormKb, listenKb } from "../keyboards";
import { handleNormalMessage, handleAutoMode } from "../services/llm";
import { startListening, stopListening } from "../services/listen";

// ══════════════════════════════════════
// ══ MESSAGE HANDLER ══════════════════
// ══════════════════════════════════════
export function registerMessageHandler(botCtx: BotContext) {

  botCtx.bot.on("message:text", async (ctx) => {
    const uid = ctx.from!.id;
    const state = getState(uid);
    const text = ctx.message.text;

    // ── Mnemonic input (before lock check) ──
    if (state.awaitingMnemonic) {
      state.awaitingMnemonic = false;
      try { await ctx.deleteMessage(); } catch {}
      const words = text.trim().split(/\s+/);
      if (words.length !== 24) {
        await safeReply(ctx, `⚠️ Expected 24 words (got ${words.length}). Try again or cancel.`, {
          reply_markup: new InlineKeyboard().text("📥 Try again", "setup_wallet_import").text("« Back", "setup_back"),
        });
        return;
      }
      try {
        const mnemonic = words.join(" ");
        const wallet = await KeypairWallet.fromMnemonic(words, { network: NETWORK, version: "V5R1" });
        const addr = wallet.address.toRawString();
        botCtx.secretStore.saveWallet(uid, mnemonic, addr);
        state.walletReady = true;
        botCtx.userAgents.delete(uid);
        botCtx.chatHistories.delete(ctx.chat!.id);
        const kb = new InlineKeyboard();
        if (!botCtx.secretStore.hasApiKey(uid)) kb.text("🧠 Set up AI key", "setup_ai_provider").row();
        kb.text("🏠 Main menu", "btn_main");
        await safeReply(ctx, `<b>✅ Wallet imported!</b>\n\n📍 <code>${escapeHtml(addr)}</code>\n🌐 ${NETWORK}`, { reply_markup: kb });
      } catch (err: any) {
        await safeReply(ctx, `⚠️ Invalid mnemonic: ${escapeHtml(err.message.slice(0, 200))}`, {
          reply_markup: new InlineKeyboard().text("📥 Try again", "setup_wallet_import").text("« Back", "setup_back"),
        });
      }
      return;
    }

    // ── API key input (before lock check) ──
    if (state.awaitingApiKey && state.pendingProvider) {
      state.awaitingApiKey = false;
      try { await ctx.deleteMessage(); } catch {}
      const apiKey = text.trim();
      (state as any)._tempApiKey = apiKey;
      const providerKey = state.pendingProvider;
      const provider = LLM_PROVIDERS[providerKey];
      if (!provider) {
        state.pendingProvider = undefined;
        delete (state as any)._tempApiKey;
        await safeReply(ctx, `⚠️ Unknown provider. Try again.`, {
          reply_markup: new InlineKeyboard().text("🧠 Choose provider", "setup_ai_provider"),
        });
        return;
      }
      // Show model selection
      const kb = new InlineKeyboard();
      for (const m of provider.models) {
        kb.text(m.label, `setup_ai_model_${providerKey}_${m.id}`).row();
      }
      kb.text("« Cancel", "setup_ai_provider");
      await safeReply(ctx, `<b>🧠 ${escapeHtml(provider.name)}</b>\n\nKey received. Now pick a model:\n\n<i>Or type a custom model name.</i>`, { reply_markup: kb });
      return;
    }

    // ── Custom model name input ──
    if ((state as any)._tempApiKey && state.pendingProvider) {
      const modelId = text.trim();
      const providerKey = state.pendingProvider;
      const provider = LLM_PROVIDERS[providerKey];
      const apiKey = (state as any)._tempApiKey;
      try {
        const testClient = new OpenAI({ apiKey, baseURL: provider?.baseURL });
        await testClient.chat.completions.create({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
        botCtx.secretStore.saveApiKey(uid, providerKey, modelId, apiKey);
        delete (state as any)._tempApiKey;
        state.pendingProvider = undefined;
        state.aiReady = true;
        botCtx.userOpenAIClients.delete(uid);
        botCtx.chatHistories.delete(ctx.chat!.id);
        const kb = new InlineKeyboard();
        if (!botCtx.secretStore.hasWallet(uid)) kb.text("🔑 Set up wallet", "setup_wallet_generate").row();
        kb.text("🏠 Main menu", "btn_main");
        await safeReply(ctx, `<b>✅ AI configured!</b>\n\n🧠 ${escapeHtml(provider?.name || providerKey)}\n🤖 ${escapeHtml(modelId)}`, { reply_markup: kb });
      } catch (err: any) {
        const status = err?.status || err?.response?.status;
        let hint = err.message?.slice(0, 200) || "Unknown error";
        if (status === 401) hint = "Invalid API key";
        else if (status === 403) hint = "No access to this model";
        else if (status === 404) hint = `Model not found: ${modelId}`;
        else if (status === 429) hint = "Rate limited. Wait and try again";
        await safeReply(ctx, `<b>❌ Validation failed</b>\n\n${escapeHtml(hint)}`, {
          reply_markup: new InlineKeyboard().text("🔄 Try again", `setup_ai_key_${providerKey}`).text("« Providers", "setup_ai_provider"),
        });
      }
      return;
    }

    // FIX #2: Lock per user to prevent chat history corruption
    if (botCtx.userLocks.get(uid)) {
      try { await ctx.reply("⏳ Still working on your last request..."); } catch {}
      return;
    }

    // TX mode text commands (kept for backward compatibility)
    const l = text.toLowerCase().trim();
    if (/\b(tx\s*auto|auto\s*approve)\b/.test(l)) {
      state.confirmTrades = false;
      await safeReply(ctx, `🔓 <b>Auto mode</b> — no approval buttons.`);
      return;
    }
    if (/\b(tx\s*confirm|approval\s*on)\b/.test(l)) {
      state.confirmTrades = true;
      await safeReply(ctx, `🔒 <b>Confirm mode</b> — approval above ${AUTO_APPROVE_LIMIT} TON.`);
      return;
    }

    // Listen filter input
    if (state.awaitingInput === "listen_filter") {
      state.awaitingInput = undefined;
      if (l === "all" || l === "clear" || l === "*") {
        state.listenFilter = undefined;
      } else {
        state.listenFilter = text.trim();
      }
      if (state.listenMode) { stopListening(uid); startListening(botCtx, uid); }
      await safeReply(ctx, `Filter set to: <b>${state.listenFilter || "all"}</b>`, { reply_markup: listenKb(0) });
      return;
    }

    // Awaiting input for transfer/swap/new_intent → route to LLM with context
    if (state.awaitingInput) {
      const prefix = state.awaitingInput === "new_intent" ? "I want to broadcast an intent for: "
        : state.awaitingInput === "transfer" ? "I want to transfer: "
        : "I want to swap: ";
      state.awaitingInput = undefined;
      return handleNormalMessage(botCtx, ctx, prefix + text);
    }

    // Offer form: parse custom price
    if (state.currentMenu === "offer_form" && state.offerDraft) {
      const match = text.match(/(\d+\.?\d*)/);
      if (match) {
        state.offerDraft.price = match[1];
        await safeReply(ctx, `Price updated to <b>${match[1]} TON</b>.\nTap "Send Offer" when ready.`, { reply_markup: offerFormKb(state.offerDraft) });
        return;
      }
    }

    // Auto Mode: start mission
    if (state.autoMode && !state.autoRunning) {
      return handleAutoMode(botCtx, ctx, state, text);
    }

    // Normal LLM handler
    return handleNormalMessage(botCtx, ctx, text);
  });
}
