import { InlineKeyboard } from "grammy";
import type { BotContext } from "../context";
import { getState, NETWORK } from "../config";
import { formatTon, shortAddr, escapeHtml, friendlyAddr, verboseLog } from "../helpers";
import { listenKb } from "../keyboards";
import { getUserAgent } from "./agent";

// ── Listen Mode ──
export function startListening(ctx: BotContext, uid: number) {
  const state = getState(uid);
  if (state.listenTimer) clearInterval(state.listenTimer);
  state.seenIntentIds = new Set();
  state.lastPollCount = 0;
  pollIntents(ctx, uid);
  state.listenTimer = setInterval(() => pollIntents(ctx, uid), state.pollInterval);
}

export function stopListening(uid: number) {
  const state = getState(uid);
  if (state.listenTimer) { clearInterval(state.listenTimer); state.listenTimer = undefined; }
  state.listenMode = false;
}

export async function pollIntents(ctx: BotContext, uid: number) {
  const state = getState(uid);
  try {
    const userAgent = await getUserAgent(ctx, uid);
    const filter: any = state.listenFilter ? { service: state.listenFilter } : {};
    const result = (await userAgent.runAction("discover_intents", filter)) as any;
    const intents = result?.intents || [];
    const newOnes = intents.filter((i: any) => !state.seenIntentIds.has(i.intentIndex));
    for (const i of intents) state.seenIntentIds.add(i.intentIndex);

    if (newOnes.length > 0) {
      const byService: Record<string, number> = {};
      for (const i of intents) { const svc = i.serviceName || i.service || "unknown"; byService[svc] = (byService[svc] || 0) + 1; }
      const topServices = Object.entries(byService).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => `${s} (${c})`).join(", ");
      verboseLog(`BOT:${uid}`, "DIRECT_REPLY", `listen mode update: ${newOnes.length} new intents`);
      await ctx.bot.api.sendMessage(uid,
        `<b>👂 Listen Mode</b> — update\n\n${intents.length} active intents\n<b>${newOnes.length} new</b> since last check\n\nTop: ${topServices}`,
        { parse_mode: "HTML", reply_markup: listenKb(newOnes.length) });
    }
    state.lastPollCount = intents.length;

    // Also poll offers on user's own intents
    await pollMyOffers(ctx, uid);
  } catch {}
}

export async function pollMyOffers(ctx: BotContext, uid: number) {
  const state = getState(uid);
  const userAgent = await getUserAgent(ctx, uid);
  for (const [intentIdx, info] of state.myActiveIntents) {
    try {
      const offers = (await userAgent.runAction("get_offers", { intentIndex: intentIdx })) as any;
      const newOffers = (offers?.offers || []).filter(
        (o: any) => o.offerIndex !== undefined && !state.seenIntentIds.has(o.offerIndex + 100000)
      );
      if (newOffers.length > 0) {
        for (const o of newOffers) state.seenIntentIds.add(o.offerIndex + 100000);
        let msg = `<b>📨 New offers on #${intentIdx} (${escapeHtml(info.service)})</b>\n\n`;
        for (const o of newOffers) {
          msg += `Offer #${o.offerIndex}: <b>${o.price ? formatTon(o.price) : "?"} TON</b>, ${o.deliveryTime || "?"} min\n`;
          msg += `Seller: <code>${escapeHtml(friendlyAddr(o.seller || "", NETWORK === "testnet"))}</code>\n\n`;
        }
        const kb = new InlineKeyboard();
        for (const o of newOffers.slice(0, 3)) kb.text(`Accept #${o.offerIndex}`, `accept_offer_${o.offerIndex}`).row();
        kb.text("View All", `view_intent_${intentIdx}`).text("« Back", "btn_main");
        verboseLog(`BOT:${uid}`, "DIRECT_REPLY", `new offers notification for intent #${intentIdx}`);
        await ctx.bot.api.sendMessage(uid, msg, { parse_mode: "HTML", reply_markup: kb });
      }
    } catch {}
  }
}
