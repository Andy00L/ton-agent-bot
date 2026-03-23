import OpenAI from "openai";
import { InlineKeyboard } from "grammy";
import { Address } from "@ton/core";
import type { BotContext } from "../context";
import type { UserState } from "../config";
import { getState, READ_ONLY_ACTIONS, NETWORK, needsApproval } from "../config";
import { escapeHtml, safeReply, friendlyAddr } from "../helpers";
import { mainMenuKb } from "../keyboards";
import { getUserAgent, getUserOpenAI, makeSystemPrompt } from "./agent";
import { requestApproval } from "./approval";
import { handleActionResult } from "./files";

// ── LLM tool loop (shared by normal + auto mode) ──
export async function executeLLMLoop(
  ctx: BotContext,
  uid: number,
  chatId: number,
  history: OpenAI.ChatCompletionMessageParam[],
  maxIter: number,
  onStep?: (step: number, action: string) => Promise<void>,
): Promise<string> {
  const userAI = getUserOpenAI(ctx, uid);
  if (!userAI) {
    throw new Error("No AI key configured. Set one up in Settings → AI Provider.");
  }
  const userAgent = await getUserAgent(ctx, uid);
  const tools = userAgent.toAITools();

  await ctx.bot.api.sendChatAction(chatId, "typing");
  let response = await userAI.client.chat.completions.create({ model: userAI.model, messages: history, tools, tool_choice: "auto" });
  let am = response.choices[0].message;
  let iter = 0;

  try {
  while (am.tool_calls && iter < maxIter) {
    iter++;
    history.push(am);
    for (const tc of am.tool_calls) {
      const fn = tc.function.name;
      const fp = JSON.parse(tc.function.arguments);
      if (onStep) try { await onStep(iter, fn); } catch {}

      // Wallet check for write actions
      if (!READ_ONLY_ACTIONS.has(fn) && !ctx.secretStore.hasWallet(uid)) {
        history.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "This action requires a wallet. Set one up in Settings." }) });
        continue;
      }

      const state = getState(uid);
      const mode = state.confirmTrades ? "confirm" : "auto";
      let approved = true;
      if (needsApproval(fn, fp, mode)) approved = await requestApproval(ctx, chatId, fn, fp);

      let result: string;
      if (approved) {
        try {
          // Normalize address params (friendly → raw) for SDK compatibility
          for (const addrKey of ["to", "address", "recipient", "beneficiary", "seller", "escrowAddress"]) {
            if (fp[addrKey] && typeof fp[addrKey] === "string") {
              try { fp[addrKey] = Address.parse(fp[addrKey]).toRawString(); } catch {}
            }
          }
          await ctx.bot.api.sendChatAction(chatId, "typing");
          const ar = await userAgent.runAction(fn, fp);
          const stored = await handleActionResult(ctx, uid, chatId, fn, ar);
          result = stored.summary;
          // pay_for_resource receipt
          if (fn === "pay_for_resource" && stored.fileId) {
            try { await ctx.bot.api.sendMessage(chatId, `<b>Paid</b> for ${escapeHtml(fp.url || "service")}\nFile saved (48h): ${stored.fileId}\nView in Files`, { parse_mode: "HTML" }); } catch {}
          }
          // Track intents
          if (fn === "broadcast_intent" && (ar as any)?.intentIndex !== undefined) {
            state.myActiveIntents.set((ar as any).intentIndex, { service: fp.service || "unknown", createdAt: Date.now() });
          }
          if ((fn === "accept_offer" || fn === "cancel_intent") && fp.intentIndex !== undefined) {
            state.myActiveIntents.delete(fp.intentIndex);
          }
          // Tx explorer link
          if (fn === "transfer_ton") {
            await new Promise((r) => setTimeout(r, 10000));
            try {
              const tx = (await userAgent.runAction("get_transaction_history", { limit: 1 })) as any;
              const h = tx?.events?.[0]?.id;
              const txAddr = ctx.secretStore.getWalletAddress(uid);
              const txFriendly = txAddr ? friendlyAddr(txAddr, NETWORK === "testnet") : ctx.devFriendlyAddr;
              result = JSON.stringify({ ...ar, explorerUrl: h ? `${ctx.viewerBase}/transaction/${h}` : `${ctx.viewerBase}/${txFriendly}`, confirmed: !!h });
            } catch {
              const fallbackAddr = ctx.secretStore.getWalletAddress(uid);
              const fallbackFriendly = fallbackAddr ? friendlyAddr(fallbackAddr, NETWORK === "testnet") : ctx.devFriendlyAddr;
              result = JSON.stringify({ ...ar, explorerUrl: `${ctx.viewerBase}/${fallbackFriendly}` });
            }
          }
        } catch (err: any) { result = JSON.stringify({ error: err.message }); }
      } else {
        result = JSON.stringify({ status: "rejected", reason: "User rejected" });
      }
      history.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
    await ctx.bot.api.sendChatAction(chatId, "typing");
    response = await userAI.client.chat.completions.create({ model: userAI.model, messages: history, tools, tool_choice: "auto" });
    am = response.choices[0].message;
  }
  } catch (loopErr: any) {
    // FIX #2: Chat history corrupted → reset and inform
    if (loopErr.message?.includes("tool_call_id") || loopErr.message?.includes("tool_calls")) {
      ctx.chatHistories.delete(chatId);
      throw new Error("Chat history was corrupted. Please try again.");
    }
    throw loopErr;
  }
  const reply = am.content || "Done!";
  history.push({ role: "assistant", content: reply });
  return reply;
}

// ── handleNormalMessage (extracted from old message:text) ──
export async function handleNormalMessage(ctx: BotContext, gramCtx: any, text: string) {
  const uid = gramCtx.from!.id;
  const chatId = gramCtx.chat.id;
  if (!getUserOpenAI(ctx, uid)) {
    await safeReply(gramCtx, `⚠️ <b>No AI key configured.</b>\n\nSet one up in Settings → AI Provider.`, {
      reply_markup: new InlineKeyboard().text("Set up AI key", "setup_ai_provider").text("Settings", "btn_settings"),
    });
    return;
  }
  ctx.userLocks.set(uid, true);
  const rawAddr = ctx.secretStore.getWalletAddress(uid);
  const userAddr = rawAddr ? friendlyAddr(rawAddr, NETWORK === "testnet") : ctx.devFriendlyAddr;
  const sysPrompt = makeSystemPrompt(ctx, uid, userAddr);
  if (!ctx.chatHistories.has(chatId)) ctx.chatHistories.set(chatId, [{ role: "system", content: sysPrompt }]);
  const history = ctx.chatHistories.get(chatId)!;
  history.push({ role: "user", content: text });
  if (history.length > 40) history.splice(1, history.length - 39);
  try {
    const reply = await executeLLMLoop(ctx, uid, chatId, history, 5);
    await safeReply(gramCtx, reply);
  } catch (err: any) {
    console.error("Error:", err.message);
    ctx.chatHistories.delete(chatId);
    await safeReply(gramCtx, `⚠️ <b>Error:</b> ${escapeHtml(err.message.slice(0, 200))}`);
  } finally {
    ctx.userLocks.set(uid, false);
  }
}

// ── Auto Mode handler ──
export async function handleAutoMode(ctx: BotContext, gramCtx: any, state: UserState, goal: string) {
  const uid = gramCtx.from!.id;
  if (!getUserOpenAI(ctx, uid)) {
    await safeReply(gramCtx, `⚠️ <b>No AI key configured.</b>\n\nSet one up in Settings → AI Provider.`, {
      reply_markup: new InlineKeyboard().text("Set up AI key", "setup_ai_provider").text("Settings", "btn_settings"),
    });
    return;
  }
  ctx.userLocks.set(uid, true);
  state.autoRunning = true;
  state.autoGoal = goal;
  const chatId = gramCtx.chat!.id;
  const statusMsg = await gramCtx.reply(
    `<b>🤖 Mission started</b>\n\nGoal: <i>${escapeHtml(goal.slice(0, 200))}</i>\n\n<i>Working...</i>`,
    { parse_mode: "HTML" },
  );
  try {
    const rawAddr = ctx.secretStore.getWalletAddress(uid);
    const userAddr = rawAddr ? friendlyAddr(rawAddr, NETWORK === "testnet") : ctx.devFriendlyAddr;
    const sysPrompt = makeSystemPrompt(ctx, uid, userAddr);
    const missionHistory: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: sysPrompt + "\n\nMISSION MODE: Execute the following mission autonomously. Be decisive. Report results concisely." },
      { role: "user", content: goal },
    ];
    let stepCount = 0;
    const reply = await executeLLMLoop(ctx, uid, chatId, missionHistory, state.maxAutoSteps, async (step, action) => {
      stepCount = step;
      try {
        await ctx.bot.api.editMessageText(chatId, statusMsg.message_id,
          `<b>🤖 Mission in progress</b>\n\nGoal: <i>${escapeHtml(goal.slice(0, 100))}</i>\n\nStep ${step}/${state.maxAutoSteps}: <code>${escapeHtml(action)}</code>...`,
          { parse_mode: "HTML" });
      } catch {}
    });
    state.autoRunning = false;
    state.autoMode = false;
    await ctx.bot.api.editMessageText(chatId, statusMsg.message_id,
      `<b>✅ Mission complete!</b>\n\n${escapeHtml(reply.slice(0, 500))}\n\nSteps: ${stepCount}\n<i>Auto mode off.</i>`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() });
  } catch (err: any) {
    state.autoRunning = false;
    state.autoMode = false;
    await ctx.bot.api.editMessageText(chatId, statusMsg.message_id,
      `<b>❌ Mission failed</b>\n\n${escapeHtml((err.message || "Unknown error").slice(0, 300))}\n\n<i>Auto mode off.</i>`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() });
  } finally {
    ctx.userLocks.set(uid, false);
  }
}
