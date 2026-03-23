import type { BotContext } from "../context";
import { verboseLog } from "../helpers";

// ══════════════════════════════════════
// ══ HITL CALLBACKS (preserved) ═══════
// ══════════════════════════════════════
export function registerHitlHandlers(botCtx: BotContext) {
  botCtx.bot.callbackQuery(/^approve_(.+)$/, async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const p = botCtx.pendingApprovals.get(ctx.match![1]);
    if (p) {
      verboseLog(`USER:${ctx.from?.id}`, "HITL_APPROVE", ctx.match![1]);
      p.resolve(true); botCtx.pendingApprovals.delete(ctx.match![1]); try { await ctx.editMessageText("✅ <b>Approved</b> — executing...", { parse_mode: "HTML" }); } catch {}
    }
    else { try { await ctx.editMessageText("⚠️ Expired.", { parse_mode: "HTML" }); } catch {} }
  });
  botCtx.bot.callbackQuery(/^reject_(.+)$/, async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const p = botCtx.pendingApprovals.get(ctx.match![1]);
    if (p) {
      verboseLog(`USER:${ctx.from?.id}`, "HITL_REJECT", ctx.match![1]);
      p.resolve(false); botCtx.pendingApprovals.delete(ctx.match![1]); try { await ctx.editMessageText("❌ <b>Rejected</b>", { parse_mode: "HTML" }); } catch {}
    }
    else { try { await ctx.editMessageText("⚠️ Expired.", { parse_mode: "HTML" }); } catch {} }
  });
}
