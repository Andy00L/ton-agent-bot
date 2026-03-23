import type { BotContext } from "../context";

// ══════════════════════════════════════
// ══ HITL CALLBACKS (preserved) ═══════
// ══════════════════════════════════════
export function registerHitlHandlers(botCtx: BotContext) {
  botCtx.bot.callbackQuery(/^approve_(.+)$/, async (ctx) => {
    const p = botCtx.pendingApprovals.get(ctx.match![1]);
    if (p) { p.resolve(true); botCtx.pendingApprovals.delete(ctx.match![1]); await ctx.editMessageText("✅ <b>Approved</b> — executing...", { parse_mode: "HTML" }); }
    else { await ctx.editMessageText("⚠️ Expired.", { parse_mode: "HTML" }); }
    await ctx.answerCallbackQuery();
  });
  botCtx.bot.callbackQuery(/^reject_(.+)$/, async (ctx) => {
    const p = botCtx.pendingApprovals.get(ctx.match![1]);
    if (p) { p.resolve(false); botCtx.pendingApprovals.delete(ctx.match![1]); await ctx.editMessageText("❌ <b>Rejected</b>", { parse_mode: "HTML" }); }
    else { await ctx.editMessageText("⚠️ Expired.", { parse_mode: "HTML" }); }
    await ctx.answerCallbackQuery();
  });
}
