import type { BotContext } from "../context";
import { getState } from "../config";
import { mainMenuKb } from "../keyboards";
import { getUserAgent } from "./agent";
import { verboseLog } from "../helpers";

// ── Offer Tracking ──
export function startOfferTracking(ctx: BotContext, uid: number) {
  const state = getState(uid);
  if (state.offerTrackTimer) return;
  state.offerTrackTimer = setInterval(async () => {
    if (state.pendingOffers.size === 0) { clearInterval(state.offerTrackTimer!); state.offerTrackTimer = undefined; return; }
    const userAgent = await getUserAgent(ctx, uid);
    for (const [offerIdx, info] of state.pendingOffers) {
      try {
        const offers = (await userAgent.runAction("get_offers", { intentIndex: info.intentIndex })) as any;
        const offer = (offers?.offers || []).find((o: any) => o.offerIndex === offerIdx);
        if (!offer) continue;
        if (offer.status === 1) {
          state.pendingOffers.delete(offerIdx);
          verboseLog(`BOT:${uid}`, "DIRECT_REPLY", `offer #${offerIdx} accepted notification`);
          await ctx.bot.api.sendMessage(uid, `<b>✅ Offer accepted!</b>\n\nYour offer #${offerIdx} on intent #${info.intentIndex} was accepted!`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
        } else if (offer.status === 2 || offer.status === 3) {
          state.pendingOffers.delete(offerIdx);
          verboseLog(`BOT:${uid}`, "DIRECT_REPLY", `offer #${offerIdx} ${offer.status === 2 ? "rejected" : "expired"} notification`);
          await ctx.bot.api.sendMessage(uid, `<b>${offer.status === 2 ? "❌ Offer rejected" : "⏰ Offer expired"}</b>\n\nOffer #${offerIdx} on intent #${info.intentIndex}.`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
        }
      } catch {}
    }
  }, 15000);
}
