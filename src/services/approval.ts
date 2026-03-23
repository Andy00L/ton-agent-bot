import { InlineKeyboard } from "grammy";
import type { BotContext } from "../context";
import { formatTon, shortAddr, escapeHtml, friendlyAddr, verboseLog } from "../helpers";

export async function requestApproval(ctx: BotContext, chatId: number, action: string, params: any): Promise<boolean> {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const kb = new InlineKeyboard().text("✅ Approve", `approve_${id}`).text("❌ Reject", `reject_${id}`);
  let msg = `🔔 <b>Approval required</b>\n\n`;
  if (action === "transfer_ton") msg += `📤 <b>Transfer</b>\n├ 💰 <b>${formatTon(params.amount)} TON</b>\n└ 📍 <code>${escapeHtml(friendlyAddr(params.to || "", ctx.network === "testnet"))}</code>`;
  else if (action === "create_escrow") msg += `🔒 <b>Create Escrow</b>\n├ 💰 <b>${formatTon(params.amount)} TON</b>\n└ 👤 <code>${escapeHtml(friendlyAddr(params.beneficiary || "", ctx.network === "testnet"))}</code>`;
  else if (action.startsWith("swap_")) msg += `🔄 <b>Swap</b>\n├ ${escapeHtml(params.fromToken || "TON")} → ${escapeHtml(params.toToken || "?")}\n└ 💰 ${escapeHtml(params.amount || "?")}`;
  else if (action === "broadcast_intent") msg += `📡 <b>Broadcast Intent</b>\n├ 🏷️ ${escapeHtml(params.service || "?")}\n└ 💰 ${escapeHtml(params.budget || "?")} TON`;
  else if (action === "send_offer") msg += `📨 <b>Send Offer</b>\n├ 📡 Intent #${params.intentIndex || "?"}\n├ 💰 ${escapeHtml(params.price || "?")} TON\n└ ⏱️ ${params.deliveryTime || "?"} min`;
  else if (action === "settle_deal") msg += `✅ <b>Settle Deal</b>\n├ 📡 Intent #${params.intentIndex || "?"}\n└ ⭐ ${params.rating || "?"}/100`;
  else if (action === "vote_release" || action === "vote_refund") msg += `⚖️ <b>${action === "vote_release" ? "Vote Release 💚" : "Vote Refund 🔴"}</b>\n└ 🔒 <code>${escapeHtml(params.escrowId || "?")}</code>`;
  else if (action === "confirm_delivery") msg += `📦 <b>Confirm Delivery</b>\n└ 🔒 <code>${escapeHtml(params.escrowId || "?")}</code>`;
  else msg += `⚡ <b>${escapeHtml(action)}</b>\n<code>${escapeHtml(JSON.stringify(params).slice(0, 200))}</code>`;
  verboseLog(`BOT:${chatId}`, "DIRECT_REPLY", `approval request for ${action}`);
  await ctx.bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", reply_markup: kb });
  return new Promise((resolve) => {
    ctx.pendingApprovals.set(id, { chatId, action, params, resolve });
    setTimeout(() => { if (ctx.pendingApprovals.has(id)) { ctx.pendingApprovals.delete(id); resolve(false); } }, 120000);
  });
}
