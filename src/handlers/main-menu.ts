import { InlineKeyboard } from "grammy";
import type { BotContext } from "../context";
import { NETWORK, getState } from "../config";
import { formatTon, shortAddr, escapeHtml } from "../helpers";
import { mainMenuKb, intentsMenuKb, browseIntentsKb, offerFormKb, settingsKb } from "../keyboards";
import { getUserAgent } from "../services/agent";
import { startOfferTracking } from "../services/tracking";

// ══════════════════════════════════════
// ══ MAIN MENU CALLBACKS ══════════════
// ══════════════════════════════════════
export function registerMainMenuHandlers(botCtx: BotContext) {

  botCtx.bot.callbackQuery("btn_main", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const hasW = botCtx.secretStore.hasWallet(uid);
    let bal = "—";
    let walletAddr = "No wallet";
    if (hasW) {
      const userAgent = await getUserAgent(botCtx, uid);
      walletAddr = botCtx.secretStore.getWalletAddress(uid)!;
      try { bal = formatTon(((await userAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
    }
    await ctx.editMessageText(
      `<b>🤖 TON Agent Kit</b>\n\n<code>${escapeHtml(walletAddr)}</code>\nBalance: <b>${bal} TON</b> · ${NETWORK}\n\nTap any button below.`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  botCtx.bot.callbackQuery("btn_balance", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    if (!botCtx.secretStore.hasWallet(uid)) {
      await ctx.editMessageText(
        `<b>💎 Balance</b>\n\n<i>No wallet configured.</i>\nSet one up to see your balance.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Set up wallet", "settings_wallet").text("« Back", "btn_main") },
      );
      return;
    }
    const userAgent = await getUserAgent(botCtx, uid);
    const walletAddr = botCtx.secretStore.getWalletAddress(uid)!;
    let bal = "?";
    try { bal = formatTon(((await userAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
    let priceInfo = "";
    try {
      const price = (await userAgent.runAction("get_price", { token: "TON" })) as any;
      if (price?.priceUSD) {
        const usd = (parseFloat(bal) * parseFloat(price.priceUSD)).toFixed(2);
        priceInfo = `\n💵 ~$${usd} (${price.priceUSD} USD/TON)`;
      }
    } catch {}
    await ctx.editMessageText(
      `<b>💎 Balance</b>\n\n<b>${bal} TON</b>${priceInfo}\n\n<a href="${botCtx.viewerBase}/${escapeHtml(walletAddr)}">🔗 Tonviewer ↗</a>`,
      { parse_mode: "HTML", reply_markup: mainMenuKb(), link_preview_options: { is_disabled: true } } as any,
    );
  });

  botCtx.bot.callbackQuery("btn_refresh", async (ctx) => {
    await ctx.answerCallbackQuery("Refreshing...");
    const uid = ctx.from!.id;
    const hasW = botCtx.secretStore.hasWallet(uid);
    let bal = "—";
    let walletAddr = "No wallet";
    if (hasW) {
      const userAgent = await getUserAgent(botCtx, uid);
      walletAddr = botCtx.secretStore.getWalletAddress(uid)!;
      try { bal = formatTon(((await userAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
    }
    await ctx.editMessageText(
      `<b>🤖 TON Agent Kit</b>\n\n<code>${escapeHtml(walletAddr)}</code>\nBalance: <b>${bal} TON</b> · ${NETWORK}\n\nTap any button below.`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  botCtx.bot.callbackQuery("btn_transfer", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.awaitingInput = "transfer";
    state.currentMenu = "main";
    await ctx.editMessageText(
      `<b>📤 Transfer</b>\n\nType your transfer request:\n\n<i>"Send 0.1 TON to EQ..."</i>\n<i>"Transfer 5 USDT to 0:abc..."</i>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Back", "btn_main") },
    );
  });

  botCtx.bot.callbackQuery("btn_swap", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.awaitingInput = "swap";
    state.currentMenu = "main";
    await ctx.editMessageText(
      `<b>🔄 Swap</b>\n\nType your swap request:\n\n<i>"Swap 1 TON to USDT"</i>\n<i>"Buy 10 USDT with TON"</i>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Back", "btn_main") },
    );
  });

  botCtx.bot.callbackQuery("btn_portfolio", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const userAgent = await getUserAgent(botCtx, ctx.from!.id);
      const r = (await userAgent.runAction("get_portfolio_metrics", { days: 7 })) as any;
      await ctx.editMessageText(
        `<b>📊 Portfolio (7d)</b>\n\n📈 PnL: <b>${r.netPnL || "0"} TON</b>\n📊 ROI: <b>${r.roi || "0"}%</b>\n🏆 Win: <b>${r.winRate || "0"}%</b>\n📉 Drawdown: <b>${r.maxDrawdown || "0"} TON</b>\n🔄 TXs: <b>${r.totalTransactions || 0}</b>\n💎 Balance: <b>${r.currentBalance || "?"} TON</b>`,
        { parse_mode: "HTML", reply_markup: mainMenuKb() },
      );
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  botCtx.bot.callbackQuery("btn_help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>❓ TON Agent Kit</b> · ${botCtx.readOnlyAgent.getAvailableActions().length} actions\n\n` +
      `━━━ <b>💰 Wallet</b> ━━━━━━━━━━\nBalance, transfers, jettons\n\n` +
      `━━━ <b>📈 DeFi</b> ━━━━━━━━━━━━\nSwaps, prices, yield\n\n` +
      `━━━ <b>🔒 Escrow</b> ━━━━━━━━━━\nDeals, deposits, disputes\n\n` +
      `━━━ <b>🤝 Agents</b> ━━━━━━━━━━\nRegister, discover, reputation\n\n` +
      `━━━ <b>🌐 x402</b> ━━━━━━━━━━━━\nPaid data endpoints\n\n` +
      `<i>Use buttons or type naturally.</i>`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  botCtx.bot.callbackQuery("btn_wallet_info", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    if (!botCtx.secretStore.hasWallet(uid)) {
      await ctx.editMessageText(
        `💎 <b>Wallet</b>\n\n<i>No wallet configured.</i>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Set up wallet", "settings_wallet").text("« Back", "btn_settings") },
      );
      return;
    }
    const userAgent = await getUserAgent(botCtx, uid);
    const walletAddr = botCtx.secretStore.getWalletAddress(uid)!;
    let bal = "?";
    try { bal = formatTon(((await userAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
    await ctx.editMessageText(
      `💎 <b>Wallet</b>\n\n📍 <code>${escapeHtml(walletAddr)}</code>\n💰 Balance: <b>${bal} TON</b>\n🌐 ${NETWORK === "testnet" ? "🧪 Testnet" : "🌐 Mainnet"}\n\n<a href="${botCtx.viewerBase}/${escapeHtml(walletAddr)}">🔗 Tonviewer ↗</a>`,
      { parse_mode: "HTML", reply_markup: settingsKb(getState(uid)), link_preview_options: { is_disabled: true } } as any,
    );
  });

  botCtx.bot.callbackQuery(/^btn_agents(?:_(\d+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userAgent = await getUserAgent(botCtx, ctx.from!.id);
    const page = parseInt(ctx.match![1] || "0");
    try {
      const result = (await userAgent.runAction("discover_agent", {
        includeOffline: true,
        limit: 5,
        offset: page * 5,
      })) as any;
      const agents = result?.agents || [];
      const total = result?.total || agents.length;
      let msg = `<b>🤝 Agents</b> (${total} total)\n\n`;
      if (agents.length === 0) {
        msg += `<i>No agents found${page > 0 ? " on this page" : ""}.</i>\n`;
        msg += `Type "register agent my-bot" to create one.`;
      } else {
        for (const a of agents) {
          const score = a.reputation?.score ?? "?";
          const status = a.available ? "🟢" : "🔴";
          msg += `${status} <b>${escapeHtml(a.name || `Agent #${a.index}`)}</b>\n`;
          msg += `├ Score: ${score}/100 | Tasks: ${a.reputation?.totalTasks || 0}\n`;
          msg += `└ <code>${shortAddr(a.address || "")}</code>\n\n`;
        }
      }
      const kb = new InlineKeyboard();
      if (page > 0) kb.text("« Prev", `btn_agents_${page - 1}`);
      kb.text("Refresh", `btn_agents_${page}`);
      if (agents.length === 5) kb.text("Next »", `btn_agents_${page + 1}`);
      kb.row().text("« Back", "btn_main");
      await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: kb });
    } catch (err: any) {
      await ctx.editMessageText(
        `⚠️ ${escapeHtml(err.message.slice(0, 200))}`,
        { parse_mode: "HTML", reply_markup: mainMenuKb() },
      );
    }
  });

  botCtx.bot.callbackQuery("btn_escrow", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userAgent = await getUserAgent(botCtx, ctx.from!.id);
    let msg = `<b>🔒 Escrow</b>\n\n`;
    let has = false;
    if (botCtx.endpointRoutes.size) {
      msg += `━━━ <b>🌐 Endpoints</b> ━━━\n`;
      for (const [p, c] of botCtx.endpointRoutes) msg += `• ${escapeHtml(p)} → ${escapeHtml(c.dataAction)} (${c.served}x)\n`;
      msg += `\n`;
      has = true;
    }
    try {
      const d = (await userAgent.runAction("get_open_disputes", { limit: 5 })) as any;
      if (d?.disputes?.length) {
        msg += `━━━ <b>⚖️ Disputes</b> ━━━\n`;
        for (const x of d.disputes.slice(0, 5)) msg += `⚖️ <code>${shortAddr(x.escrowAddress || "")}</code> · <b>${x.amount ? formatTon(x.amount) : "?"} TON</b>\n`;
        has = true;
      }
    } catch {}
    if (!has) msg += `<i>No active escrows or disputes.</i>`;
    await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: mainMenuKb() });
  });

  botCtx.bot.callbackQuery("btn_offers", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    if (state.pendingOffers.size === 0) {
      await ctx.editMessageText(`<b>📨 My Offers</b>\n\n<i>No pending offers.</i>\n\nBrowse intents and send offers to track them here.`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
      return;
    }
    let msg = `<b>📨 My Offers</b> (${state.pendingOffers.size} pending)\n\n`;
    for (const [offerIdx, info] of state.pendingOffers) {
      const age = Math.round((Date.now() - info.sentAt) / 60000);
      msg += `• Offer #${offerIdx} → Intent #${info.intentIndex} (${age}m ago)\n`;
    }
    await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: mainMenuKb() });
  });

  // ══════════════════════════════════════
  // ══ INTENTS CALLBACKS ════════════════
  // ══════════════════════════════════════

  botCtx.bot.callbackQuery("btn_intents", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    const userAgent = await getUserAgent(botCtx, uid);
    state.currentMenu = "intents";
    try {
      const myAddr = botCtx.secretStore.getWalletAddress(uid) || botCtx.devAddress;
      const allIntents = (await userAgent.runAction("discover_intents", {})) as any;
      const intents = allIntents?.intents || [];
      const myIntents = intents.filter((i: any) => i.buyer === myAddr);
      let msg = `<b>📡 Service Marketplace</b>\n\nYour active intents: <b>${myIntents.length}</b>\n\n`;
      for (const i of myIntents.slice(0, 5)) {
        const svc = i.serviceName || i.service || "?";
        let offerCount = 0;
        try { const or = (await userAgent.runAction("get_offers", { intentIndex: i.intentIndex })) as any; offerCount = or?.offers?.length || 0; } catch {}
        msg += `#${i.intentIndex} <b>${escapeHtml(svc)}</b> — ${i.budget ? formatTon(i.budget) : "?"} TON — ${offerCount} offers\n`;
      }
      if (myIntents.length === 0) msg += `<i>No active intents. Tap "New Intent" to start.</i>\n`;
      await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: intentsMenuKb(myIntents) });
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  botCtx.bot.callbackQuery("btn_intents_refresh", async (ctx) => {
    // Same as btn_intents
    await ctx.answerCallbackQuery("Refreshing...");
    const uid = ctx.from!.id;
    const userAgent = await getUserAgent(botCtx, uid);
    try {
      const allIntents = (await userAgent.runAction("discover_intents", {})) as any;
      const intents = allIntents?.intents || [];
      const myAddr = botCtx.secretStore.getWalletAddress(uid) || botCtx.devAddress;
      const myIntents = intents.filter((i: any) => i.buyer === myAddr);
      let msg = `<b>📡 Service Marketplace</b>\n\nYour active intents: <b>${myIntents.length}</b>\n\n`;
      for (const i of myIntents.slice(0, 5)) {
        const svc = i.serviceName || i.service || "?";
        msg += `#${i.intentIndex} <b>${escapeHtml(svc)}</b> — ${i.budget ? formatTon(i.budget) : "?"} TON\n`;
      }
      if (myIntents.length === 0) msg += `<i>No active intents.</i>\n`;
      await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: intentsMenuKb(myIntents) });
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  botCtx.bot.callbackQuery("btn_browse", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const userAgent = await getUserAgent(botCtx, ctx.from!.id);
      const intents = (await userAgent.runAction("discover_intents", {})) as any;
      const list = intents?.intents || [];
      let msg = `<b>🔍 Open Intents</b> (${intents?.total || list.length} active)\n\n`;
      for (const i of list.slice(0, 5)) {
        const svc = i.serviceName || i.service || i.serviceHash?.slice(0, 12) || "?";
        msg += `<b>#${i.intentIndex} ${escapeHtml(svc)}</b>\n├ 💰 ${i.budget ? formatTon(i.budget) : "?"} TON\n└ 👤 <code>${escapeHtml(shortAddr(i.buyer || ""))}</code>\n\n`;
      }
      if (list.length === 0) msg += `<i>No open intents right now.</i>`;
      await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: browseIntentsKb(list, 0) });
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  botCtx.bot.callbackQuery(/^browse_page_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userAgent = await getUserAgent(botCtx, ctx.from!.id);
    const page = parseInt(ctx.match![1]);
    try {
      const intents = (await userAgent.runAction("discover_intents", {})) as any;
      const list = intents?.intents || [];
      const offset = page * 5;
      const pageItems = list.slice(offset, offset + 5);
      let msg = `<b>🔍 Open Intents</b> (page ${page + 1})\n\n`;
      for (const i of pageItems) {
        const svc = i.serviceName || i.service || "?";
        msg += `<b>#${i.intentIndex} ${escapeHtml(svc)}</b>\n├ 💰 ${i.budget ? formatTon(i.budget) : "?"} TON\n└ 👤 <code>${escapeHtml(shortAddr(i.buyer || ""))}</code>\n\n`;
      }
      if (pageItems.length === 0) msg += `<i>No more intents.</i>`;
      await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: browseIntentsKb(pageItems, page) });
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  botCtx.bot.callbackQuery("btn_new_intent", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.awaitingInput = "new_intent";
    await ctx.editMessageText(
      `<b>📡 New Intent</b>\n\nDescribe what service you need:\n\n<i>"I need a price feed for TON/USDT"</i>\n<i>"Looking for analytics data, budget 0.5 TON"</i>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Back", "btn_intents") },
    );
  });

  botCtx.bot.callbackQuery("btn_my_offers", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    if (state.pendingOffers.size === 0) {
      await ctx.editMessageText(`<b>📨 My Sent Offers</b>\n\n<i>No pending offers.</i>`, { parse_mode: "HTML", reply_markup: intentsMenuKb([]) });
      return;
    }
    let msg = `<b>📨 My Sent Offers</b>\n\n`;
    for (const [offerIdx, info] of state.pendingOffers) {
      const age = Math.round((Date.now() - info.sentAt) / 60000);
      msg += `• Offer #${offerIdx} → Intent #${info.intentIndex} (${age}m ago)\n`;
    }
    await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: intentsMenuKb([]) });
  });

  botCtx.bot.callbackQuery(/^view_intent_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userAgent = await getUserAgent(botCtx, ctx.from!.id);
    const intentIdx = parseInt(ctx.match![1]);
    try {
      const intents = (await userAgent.runAction("discover_intents", {})) as any;
      const intent = (intents?.intents || []).find((i: any) => i.intentIndex === intentIdx);
      const offers = (await userAgent.runAction("get_offers", { intentIndex: intentIdx })) as any;
      const offerList = offers?.offers || [];
      let msg = `<b>📡 Intent #${intentIdx}</b>\n\n`;
      if (intent) {
        const svc = intent.serviceName || intent.service || "?";
        msg += `🏷️ Service: <b>${escapeHtml(svc)}</b>\n💰 Budget: <b>${intent.budget ? formatTon(intent.budget) : "?"} TON</b>\n👤 Buyer: <code>${escapeHtml(shortAddr(intent.buyer || ""))}</code>\n\n`;
      }
      msg += `<b>Offers (${offerList.length}):</b>\n\n`;
      for (const o of offerList.slice(0, 5)) {
        msg += `#${o.offerIndex}: <b>${o.price ? formatTon(o.price) : "?"} TON</b>, ${o.deliveryTime || "?"} min\n└ <code>${shortAddr(o.seller || "")}</code>\n\n`;
      }
      const kb = new InlineKeyboard();
      for (const o of offerList.slice(0, 3)) kb.text(`Accept #${o.offerIndex}`, `accept_offer_${o.offerIndex}`).row();
      kb.text("« Back", "btn_intents");
      await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: kb });
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  // ══════════════════════════════════════
  // ══ OFFER FORM CALLBACKS ═════════════
  // ══════════════════════════════════════

  botCtx.bot.callbackQuery(/^offer_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    const intentIdx = parseInt(ctx.match![1]);
    state.currentMenu = "offer_form";
    state.offerDraft = { intentIndex: intentIdx, price: "0.1", deliveryTime: 5 };
    await ctx.editMessageText(
      `<b>📨 Offer on Intent #${intentIdx}</b>\n\nPrice: <b>${state.offerDraft.price} TON</b>\nDelivery: <b>${state.offerDraft.deliveryTime} min</b>\n\nTap to change, or type a custom amount.`,
      { parse_mode: "HTML", reply_markup: offerFormKb(state.offerDraft) },
    );
  });

  botCtx.bot.callbackQuery(/^price_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    if (!state.offerDraft) return;
    state.offerDraft.price = ctx.match![1];
    await ctx.editMessageText(
      `<b>📨 Offer on Intent #${state.offerDraft.intentIndex}</b>\n\nPrice: <b>${state.offerDraft.price} TON</b>\nDelivery: <b>${state.offerDraft.deliveryTime} min</b>\n\nTap to change, or type a custom amount.`,
      { parse_mode: "HTML", reply_markup: offerFormKb(state.offerDraft) },
    );
  });

  botCtx.bot.callbackQuery(/^time_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    if (!state.offerDraft) return;
    state.offerDraft.deliveryTime = parseInt(ctx.match![1]);
    await ctx.editMessageText(
      `<b>📨 Offer on Intent #${state.offerDraft.intentIndex}</b>\n\nPrice: <b>${state.offerDraft.price} TON</b>\nDelivery: <b>${state.offerDraft.deliveryTime} min</b>\n\nTap to change, or type a custom amount.`,
      { parse_mode: "HTML", reply_markup: offerFormKb(state.offerDraft) },
    );
  });

  botCtx.bot.callbackQuery("btn_send_offer", async (ctx) => {
    await ctx.answerCallbackQuery("Sending offer...");
    const uid = ctx.from!.id;
    const state = getState(uid);
    const draft = state.offerDraft;
    if (!draft) return;
    if (!botCtx.secretStore.hasWallet(uid)) {
      await ctx.editMessageText(`⚠️ This action requires a wallet. Set one up in Settings.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Set up wallet", "settings_wallet").text("« Back", "btn_main") });
      return;
    }
    try {
      const userAgent = await getUserAgent(botCtx, uid);
      const result = (await userAgent.runAction("send_offer", {
        intentIndex: draft.intentIndex,
        price: draft.price,
        deliveryTime: draft.deliveryTime,
        endpoint: "pending",
      })) as any;
      if (result?.offerIndex !== undefined) {
        state.pendingOffers.set(result.offerIndex, { intentIndex: draft.intentIndex, sentAt: Date.now() });
        startOfferTracking(botCtx, uid);
      }
      state.offerDraft = undefined;
      state.currentMenu = "main";
      await ctx.editMessageText(
        `<b>✅ Offer sent!</b>\n\nIntent #${draft.intentIndex}\nPrice: ${draft.price} TON\nDelivery: ${draft.deliveryTime} min\n\n<i>Tracking... You'll be notified when accepted.</i>`,
        { parse_mode: "HTML", reply_markup: mainMenuKb() },
      );
    } catch (err: any) {
      await ctx.editMessageText(`<b>❌ Offer failed</b>\n\n${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  // ══════════════════════════════════════
  // ══ ACCEPT / CANCEL CALLBACKS ════════
  // ══════════════════════════════════════

  botCtx.bot.callbackQuery(/^accept_offer_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Accepting offer...");
    const uid = ctx.from!.id;
    if (!botCtx.secretStore.hasWallet(uid)) {
      await ctx.editMessageText(`⚠️ This action requires a wallet. Set one up in Settings.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Set up wallet", "settings_wallet").text("« Back", "btn_main") });
      return;
    }
    const userAgent = await getUserAgent(botCtx, uid);
    const offerIdx = parseInt(ctx.match![1]);
    try {
      await userAgent.runAction("accept_offer", { offerIndex: offerIdx });
      await ctx.editMessageText(
        `<b>✅ Offer #${offerIdx} accepted!</b>\n\nCreating escrow and depositing funds...\n<i>You'll be guided through the next steps.</i>`,
        { parse_mode: "HTML", reply_markup: mainMenuKb() },
      );
    } catch (err: any) {
      await ctx.editMessageText(`<b>❌ Accept failed</b>\n\n${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  botCtx.bot.callbackQuery(/^cancel_intent_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Cancelling...");
    const uid = ctx.from!.id;
    if (!botCtx.secretStore.hasWallet(uid)) {
      await ctx.editMessageText(`⚠️ This action requires a wallet. Set one up in Settings.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Set up wallet", "settings_wallet").text("« Back", "btn_main") });
      return;
    }
    const userAgent = await getUserAgent(botCtx, uid);
    const intentIdx = parseInt(ctx.match![1]);
    const state = getState(uid);
    try {
      await userAgent.runAction("cancel_intent", { intentIndex: intentIdx });
      state.myActiveIntents.delete(intentIdx);
      await ctx.editMessageText(`<b>✅ Intent #${intentIdx} cancelled.</b>`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    } catch (err: any) {
      await ctx.editMessageText(`<b>❌ Cancel failed</b>\n\n${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });
}
