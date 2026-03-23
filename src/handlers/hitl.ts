import type { BotContext } from "../context";

// ══════════════════════════════════════
// ══ HITL CALLBACKS (preserved) ═══════
// ══════════════════════════════════════
export function registerHitlHandlers(botCtx: BotContext) {
  botCtx.bot.callbackQuery(/^approve_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = botCtx.pendingApprovals.get(ctx.match![1]);
    if (p) { p.resolve(true); botCtx.pendingApprovals.delete(ctx.match![1]); try { await ctx.editMessageText("✅ <b>Approved</b> — executing...", { parse_mode: "HTML" }); } catch {} }
    else { try { await ctx.editMessageText("⚠️ Expired.", { parse_mode: "HTML" }); } catch {} }
  });
  botCtx.bot.callbackQuery(/^reject_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = botCtx.pendingApprovals.get(ctx.match![1]);
    if (p) { p.resolve(false); botCtx.pendingApprovals.delete(ctx.match![1]); try { await ctx.editMessageText("❌ <b>Rejected</b>", { parse_mode: "HTML" }); } catch {} }
    else { try { await ctx.editMessageText("⚠️ Expired.", { parse_mode: "HTML" }); } catch {} }
  });
}
