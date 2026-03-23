import { InlineKeyboard } from "grammy";
import type { UserState } from "./config";

// ── Keyboards ──
export function mainMenuKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💎 Balance", "btn_balance").text("📤 Transfer", "btn_transfer").row()
    .text("📡 Intents", "btn_intents").text("📨 Offers", "btn_offers").text("🤝 Agents", "btn_agents").row()
    .text("🔒 Escrow", "btn_escrow").text("🔄 Swap", "btn_swap").row()
    .text("👂 Listen", "btn_listen").text("🤖 Auto", "btn_auto").row()
    .text("⚙️ Settings", "btn_settings").text("📁 Files", "btn_files").text("🔄 Refresh", "btn_refresh").row()
    .text("📊 Portfolio", "btn_portfolio").text("❓ Help", "btn_help");
}

export function intentsMenuKb(myIntents: any[]): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("📡 New Intent", "btn_new_intent").text("🔍 Browse All", "btn_browse").row();
  for (const i of myIntents.slice(0, 5)) {
    kb.text(`View #${i.intentIndex}`, `view_intent_${i.intentIndex}`)
      .text(`Cancel #${i.intentIndex}`, `cancel_intent_${i.intentIndex}`).row();
  }
  kb.text("📨 My Offers", "btn_my_offers").text("🔄 Refresh", "btn_intents_refresh").row();
  kb.text("« Back", "btn_main");
  return kb;
}

export function browseIntentsKb(intents: any[], page: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const i of intents.slice(0, 5)) {
    kb.text(`Offer on #${i.intentIndex}`, `offer_${i.intentIndex}`).row();
  }
  if (page > 0) kb.text("« Prev", `browse_page_${page - 1}`);
  if (intents.length === 5) kb.text("Next »", `browse_page_${page + 1}`);
  if (page > 0 || intents.length === 5) kb.row();
  kb.text("« Back", "btn_intents");
  return kb;
}

export function offerFormKb(draft: any): InlineKeyboard {
  return new InlineKeyboard()
    .text("0.05 TON", "price_0.05").text("0.1 TON", "price_0.1").text("0.2 TON", "price_0.2").row()
    .text("5 min", "time_5").text("15 min", "time_15").text("1 hour", "time_60").row()
    .text("✅ Send Offer", "btn_send_offer").text("« Cancel", "btn_intents").row();
}

export function settingsKb(state: UserState): InlineKeyboard {
  return new InlineKeyboard()
    .text(state.confirmTrades ? "🔒 Confirm ON" : "🔓 Confirm OFF", "toggle_confirm")
    .text(state.autoMode ? "🤖 Auto ON" : "🤖 Auto OFF", "toggle_auto").row()
    .text(state.listenMode ? "👂 Listen ON" : "👂 Listen OFF", "toggle_listen")
    .text(`⚡ HITL: ${state.hitlThreshold} TON`, "cycle_hitl").row()
    .text(`🔢 Steps: ${state.maxAutoSteps}`, "cycle_steps")
    .text(`⏱️ Poll: ${state.pollInterval / 1000}s`, "cycle_poll").row()
    .text("💰 Wallet", "settings_wallet").text("🧠 AI Provider", "settings_ai").row()
    .text("💎 Wallet Info", "btn_wallet_info").text("« Back", "btn_main").row();
}

export function listenKb(newCount: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (newCount > 0) kb.text(`📬 Show New (${newCount})`, "btn_show_new").row();
  kb.text("🔍 Filter", "btn_listen_filter").text("🎲 Random 5", "btn_listen_random").row();
  kb.text("⏹️ Stop", "btn_stop_listen").text("🔄 Poll Now", "btn_poll_now").row();
  kb.text("« Back", "btn_main");
  return kb;
}

export function autoModeKb(state: UserState): InlineKeyboard {
  return new InlineKeyboard()
    .text("⏹️ Stop Auto", "btn_stop_auto").text(`🔢 Steps: ${state.maxAutoSteps}`, "cycle_steps").row()
    .text("« Back", "btn_main");
}
