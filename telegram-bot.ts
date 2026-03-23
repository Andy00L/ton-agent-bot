import { TonClient4 } from "@ton/ton";
import { mnemonicNew } from "@ton/crypto";
import { readFileSync } from "fs";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import OpenAI from "openai";
import { TonAgentKit } from "@ton-agent-kit/core";
import { KeypairWallet } from "@ton-agent-kit/core";
import { SecretStore, ensureServerSecret, LLM_PROVIDERS, FileStore, MAX_FILE_SIZE, MAX_USER_STORAGE } from "@ton-agent-kit/wallet-store";
import { createEndpointPlugin, type EndpointConfig } from "@ton-agent-kit/plugin-endpoints";
import { selectNetworkMode } from "@ton-agent-kit/network-mode";
import AnalyticsPlugin from "@ton-agent-kit/plugin-analytics";
import DefiPlugin from "@ton-agent-kit/plugin-defi";
import DnsPlugin from "@ton-agent-kit/plugin-dns";
import NftPlugin from "@ton-agent-kit/plugin-nft";
import EscrowPlugin from "@ton-agent-kit/plugin-escrow";
import IdentityPlugin from "@ton-agent-kit/plugin-identity";
import StakingPlugin from "@ton-agent-kit/plugin-staking";
import TokenPlugin from "@ton-agent-kit/plugin-token";
import PaymentsPlugin from "@ton-agent-kit/plugin-payments";
import AgentCommPlugin from "@ton-agent-kit/plugin-agent-comm";
import {
  tonPaywall,
  MemoryReplayStore,
} from "@ton-agent-kit/x402-middleware";
import express from "express";

const envContent = readFileSync(".env", "utf-8");
const getEnv = (key: string) =>
  envContent
    .split("\n")
    .find((l) => l.startsWith(key + "="))
    ?.slice(key.length + 1)
    .trim() || "";

process.env.TON_MNEMONIC = getEnv("TON_MNEMONIC");
process.env.TELEGRAM_BOT_TOKEN = getEnv("TELEGRAM_BOT_TOKEN");
process.env.OPENAI_API_KEY = getEnv("OPENAI_API_KEY");
process.env.OPENAI_BASE_URL = getEnv("OPENAI_BASE_URL");
process.env.AI_MODEL = getEnv("AI_MODEL");
process.env.TON_NETWORK = getEnv("TON_NETWORK");
process.env.TON_RPC_URL = getEnv("TON_RPC_URL");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const MNEMONIC = process.env.TON_MNEMONIC || "";
const NETWORK = (process.env.TON_NETWORK as "testnet" | "mainnet") || "testnet";
const RPC_URL = process.env.TON_RPC_URL || "https://testnet-v4.tonhubapi.com";
const X402_PORT = parseInt(getEnv("X402_PORT") || "4000", 10);
const AUTO_APPROVE_LIMIT = 0.05;

// ── HITL action sets ──
const HITL_ACTIONS = new Set([
  "transfer_ton", "transfer_jetton", "create_escrow",
  "deposit_to_escrow", "release_escrow", "refund_escrow",
  "open_dispute", "accept_offer", "stake_ton", "unstake_ton",
  "swap_dedust", "swap_stonfi", "swap_best_price",
  "broadcast_intent", "join_dispute", "seller_stake_escrow",
  "settle_deal", "confirm_delivery", "send_offer",
  "vote_release", "vote_refund", "claim_reward", "cancel_intent",
  "register_agent", "deploy_jetton",  // FIX #1: added for HITL coverage
]);
const ALWAYS_CONFIRM = new Set([
  "vote_release", "vote_refund", "confirm_delivery",
  "settle_deal", "send_offer", "cancel_intent",
  "open_dispute", "join_dispute",
  "register_agent",          // FIX #1: no amount field
  "broadcast_intent",        // FIX #1: budget is a string, not amount
  "accept_offer",            // FIX #1: engages a deal, no amount
  "deploy_jetton",           // FIX #1: deploys a contract
  "create_escrow",           // FIX #1: deploys an escrow contract
  "deposit_to_escrow",       // FIX #1: amount in custom field
  "seller_stake_escrow",     // FIX #1: stake, not amount
]);

const READ_ONLY_ACTIONS = new Set([
  "get_balance", "get_jetton_balance", "get_jetton_info",
  "get_price", "get_token_trust",
  "get_staking_pools", "get_staking_info", "get_yield_pools",
  "resolve_domain", "lookup_address", "get_domain_info",
  "get_nft_info", "get_nft_collection",
  "discover_agent", "get_agent_reputation", "get_agent_cleanup_info",
  "discover_intents", "get_offers", "get_open_disputes",
  "get_transaction_history", "get_wallet_info", "get_portfolio_metrics",
  "get_equity_curve", "get_escrow_info",
  "get_delivery_proof", "simulate_transaction",
  "get_context", "list_context",
  "call_contract_method", "get_accounts_bulk",
  "ton_agent_info", "list_x402_endpoints",
]);

function needsApproval(action: string, params: any, mode: string): boolean {
  if (mode !== "confirm") return false;
  if (!HITL_ACTIONS.has(action)) return false;
  if (ALWAYS_CONFIRM.has(action)) return true;
  const a = parseFloat(params.amount ?? params.value ?? params.budget ?? params.stake ?? params.price ?? "0");
  if (a === 0 && params.amount === undefined && params.value === undefined) {
    // No amount field at all → always confirm for safety
    return true;
  }
  return isNaN(a) || a >= AUTO_APPROVE_LIMIT;
}

// ── Pending approvals (HITL) ──
const pendingApprovals = new Map<
  string,
  { chatId: number; action: string; params: any; resolve: (approved: boolean) => void }
>();

// ── Helpers ──
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function shortAddr(addr: string): string {
  if (!addr) return "unknown";
  if (addr.length > 20) return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
  return addr;
}
function formatTon(amount: string | number): string {
  return parseFloat(String(amount)).toFixed(4);
}

// ── UserState ──
interface UserState {
  currentMenu: string;
  mainMessageId?: number;
  confirmTrades: boolean;
  hitlThreshold: number;
  autoMode: boolean;
  listenMode: boolean;
  listenFilter?: string;
  maxAutoSteps: number;
  pollInterval: number;
  listenTimer?: ReturnType<typeof setInterval>;
  seenIntentIds: Set<number>;
  lastPollCount: number;
  pendingOffers: Map<number, { intentIndex: number; sentAt: number }>;
  offerTrackTimer?: ReturnType<typeof setInterval>;
  myActiveIntents: Map<number, { service: string; createdAt: number }>;
  offerDraft?: { intentIndex: number; price: string; deliveryTime: number };
  autoRunning: boolean;
  autoGoal?: string;
  awaitingInput?: "transfer" | "swap" | "new_intent" | "listen_filter" | null;
  // Multi-user
  walletReady: boolean;
  aiReady: boolean;
  awaitingMnemonic: boolean;
  awaitingApiKey: boolean;
  pendingProvider?: string;
}

const userStates = new Map<number, UserState>();
const userLocks = new Map<number, boolean>();
const userAgents = new Map<number, TonAgentKit>();
const userOpenAIClients = new Map<number, { client: OpenAI; model: string }>();
let secretStore: SecretStore;
let publicUrl: string = "";

function getState(uid: number): UserState {
  if (!userStates.has(uid)) {
    userStates.set(uid, {
      currentMenu: "main",
      confirmTrades: true,
      hitlThreshold: 0.05,
      autoMode: false,
      listenMode: false,
      maxAutoSteps: 10,
      pollInterval: 30000,
      seenIntentIds: new Set(),
      lastPollCount: 0,
      pendingOffers: new Map(),
      myActiveIntents: new Map(),
      autoRunning: false,
      walletReady: false,
      aiReady: false,
      awaitingMnemonic: false,
      awaitingApiKey: false,
    });
  }
  return userStates.get(uid)!;
}

// ── Keyboards ──
function mainMenuKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💎 Balance", "btn_balance").text("📤 Transfer", "btn_transfer").row()
    .text("📡 Intents", "btn_intents").text("📨 Offers", "btn_offers").text("🤝 Agents", "btn_agents").row()
    .text("🔒 Escrow", "btn_escrow").text("🔄 Swap", "btn_swap").row()
    .text("👂 Listen", "btn_listen").text("🤖 Auto", "btn_auto").row()
    .text("⚙️ Settings", "btn_settings").text("📁 Files", "btn_files").text("🔄 Refresh", "btn_refresh").row()
    .text("📊 Portfolio", "btn_portfolio").text("❓ Help", "btn_help");
}

function intentsMenuKb(myIntents: any[]): InlineKeyboard {
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

function browseIntentsKb(intents: any[], page: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const i of intents.slice(0, 5)) {
    kb.text(`Offer on #${i.intentIndex}`, `offer_${i.intentIndex}`).row();
  }
  if (page > 0) kb.text("« Prev", `browse_page_${page - 1}`);
  kb.text("Next »", `browse_page_${page + 1}`).row();
  kb.text("« Back", "btn_intents");
  return kb;
}

function offerFormKb(draft: any): InlineKeyboard {
  return new InlineKeyboard()
    .text("0.05 TON", "price_0.05").text("0.1 TON", "price_0.1").text("0.2 TON", "price_0.2").row()
    .text("5 min", "time_5").text("15 min", "time_15").text("1 hour", "time_60").row()
    .text("✅ Send Offer", "btn_send_offer").text("« Cancel", "btn_intents").row();
}

function settingsKb(state: UserState): InlineKeyboard {
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

function listenKb(newCount: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (newCount > 0) kb.text(`📬 Show New (${newCount})`, "btn_show_new").row();
  kb.text("🔍 Filter", "btn_listen_filter").text("🎲 Random 5", "btn_listen_random").row();
  kb.text("⏹️ Stop", "btn_stop_listen").text("🔄 Poll Now", "btn_poll_now").row();
  kb.text("« Back", "btn_main");
  return kb;
}

function autoModeKb(state: UserState): InlineKeyboard {
  return new InlineKeyboard()
    .text("⏹️ Stop Auto", "btn_stop_auto").text(`🔢 Steps: ${state.maxAutoSteps}`, "cycle_steps").row()
    .text("« Back", "btn_main");
}

// ── x402 Endpoint Routes (shared between plugin and express server) ──
const endpointRoutes = new Map<string, EndpointConfig>();

// ══════════════════════════════════════════════
// ══ MAIN ═════════════════════════════════════
// ══════════════════════════════════════════════
async function main() {
  // Step 1: Network mode
  publicUrl = await selectNetworkMode(X402_PORT);
  console.log(`  Network: ${publicUrl}\n`);

  // Step 2: Secret store
  const serverSecret = ensureServerSecret();
  secretStore = new SecretStore("data/wallets.db", serverSecret);

  const fileStore = new FileStore(secretStore.getDb(), "data/files");

  // Step 3: Endpoint plugin (factory — uses publicUrl + shared routes map)
  const EndpointPlugin = createEndpointPlugin({
    port: X402_PORT,
    getPublicUrl: () => publicUrl,
    routes: endpointRoutes,
  });

  // Step 4: Existing bot setup
  console.log("🤖 Starting TON Agent Kit Telegram Bot...");
  const client = new TonClient4({ endpoint: RPC_URL });
  const viewerBase = NETWORK === "mainnet" ? "https://tonviewer.com" : "https://testnet.tonviewer.com";

  // Dev wallet (optional — readOnlyAgent fallback)
  let readOnlyAgent: TonAgentKit;
  let devAddress = "";
  let devFriendlyAddr = "";
  if (MNEMONIC) {
    const wallet = await KeypairWallet.autoDetect(MNEMONIC.split(" "), client, NETWORK);
    devAddress = wallet.address.toRawString();
    devFriendlyAddr = wallet.address.toString({ testOnly: NETWORK === "testnet", bounceable: false });
    readOnlyAgent = new TonAgentKit(wallet, RPC_URL, {}, NETWORK)
      .use(TokenPlugin).use(DefiPlugin).use(DnsPlugin).use(NftPlugin)
      .use(StakingPlugin).use(EscrowPlugin).use(IdentityPlugin)
      .use(AnalyticsPlugin).use(PaymentsPlugin).use(AgentCommPlugin)
      .use(EndpointPlugin);
  } else {
    // Minimal agent with a throwaway wallet for read-only queries
    const tempMnemonic = await mnemonicNew(24);
    const tempWallet = await KeypairWallet.fromMnemonic(tempMnemonic, { network: NETWORK, version: "V5R1" });
    devAddress = tempWallet.address.toRawString();
    devFriendlyAddr = tempWallet.address.toString({ testOnly: NETWORK === "testnet", bounceable: false });
    readOnlyAgent = new TonAgentKit(tempWallet, RPC_URL, {}, NETWORK)
      .use(TokenPlugin).use(DefiPlugin).use(DnsPlugin).use(NftPlugin)
      .use(StakingPlugin).use(EscrowPlugin).use(IdentityPlugin)
      .use(AnalyticsPlugin).use(PaymentsPlugin).use(AgentCommPlugin)
      .use(EndpointPlugin);
  }

  const bot = new Bot(BOT_TOKEN);
  const chatHistories = new Map<number, OpenAI.ChatCompletionMessageParam[]>();

  // ── Per-user agent + OpenAI helpers ──
  async function getUserAgent(uid: number): Promise<TonAgentKit> {
    if (userAgents.has(uid)) return userAgents.get(uid)!;
    const stored = secretStore.loadWallet(uid);
    if (!stored) return readOnlyAgent;
    const words = stored.mnemonic.split(" ");
    const wallet = await KeypairWallet.fromMnemonic(words, { network: NETWORK, version: "V5R1" });
    const userAgent = new TonAgentKit(wallet, RPC_URL, {}, NETWORK)
      .use(TokenPlugin).use(DefiPlugin).use(DnsPlugin).use(NftPlugin)
      .use(StakingPlugin).use(EscrowPlugin).use(IdentityPlugin)
      .use(AnalyticsPlugin).use(PaymentsPlugin).use(AgentCommPlugin);
    userAgents.set(uid, userAgent);
    return userAgent;
  }

  function getUserOpenAI(uid: number): { client: OpenAI; model: string } | null {
    if (userOpenAIClients.has(uid)) return userOpenAIClients.get(uid)!;
    const stored = secretStore.loadApiKey(uid);
    if (!stored) return null;
    const provider = LLM_PROVIDERS[stored.provider];
    const entry = {
      client: new OpenAI({
        apiKey: stored.apiKey,
        baseURL: provider?.baseURL,
      }),
      model: stored.model,
    };
    userOpenAIClients.set(uid, entry);
    return entry;
  }

  function makeSystemPrompt(uid: number, userAddr: string): string {
    return `You are TON Agent Kit Bot — an AI agent on TON blockchain inside Telegram.
You run an x402 HTTP server at ${publicUrl} for paid data endpoints.

Wallet: ${userAddr} | Network: ${NETWORK} | Actions: ${readOnlyAgent.actionCount}

PLUGINS: Wallet/Tokens, DeFi, DNS, NFT, Staking, Escrow, Identity, Analytics, Payments, AgentComm, x402 Endpoints

🌐 x402 ENDPOINTS — YOU CAN SELL DATA:
- open_x402_endpoint: open a paid endpoint (pick path, price, SDK action)
- close_x402_endpoint: close when done
- list_x402_endpoints: see what's open

CRITICAL: When responding to an intent with send_offer:
1. FIRST open an x402 endpoint with open_x402_endpoint
2. THEN send_offer with the endpoint URL from step 1
3. NEVER use fake URLs like "example/api"

Example: open_x402_endpoint({ path: "/api/price", price: "0.005", dataAction: "get_price", dataParams: "{\\"tokenAddress\\":\\"EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs\\"}" })
Then: send_offer({ intentIndex: 3, price: "0.05", endpoint: "${publicUrl}/api/price" })

WORKFLOWS:

🛒 BUYING: broadcast_intent → wait for offers → get_offers → accept_offer → create_escrow → deposit → confirm_delivery → release_escrow → rate

🏪 SELLING: discover_intents → open_x402_endpoint → send_offer (with real URL) → wait for acceptance → close_x402_endpoint after settlement

🔒 ESCROW: create_escrow, deposit_to_escrow, release_escrow, refund_escrow, confirm_delivery, open_dispute, join_dispute, vote_release, vote_refund

IMPORTANT RULES:
- Before registering, call discover_agent to check if you already exist
- Before opening an endpoint, call list_x402_endpoints to see what's open
- Extract seller address from get_offers results for create_escrow beneficiary
- Execute actions IMMEDIATELY — system handles approval buttons

FORMATTING RULES:
- Keep responses concise and plain text.
- Do NOT use HTML tags like <b>, <i>, <code> in your responses. The bot handles formatting.
- Use simple text formatting: numbers, bullet points with -, and clear labels.
- Use ├ └ tree lines and emojis for structure: 💎 wallet, 📈 price, 🤝 agents, 📡 intents, ⚖️ disputes, 🔒 escrow, 🌐 endpoints
- Format TON to 4 decimals.
- When showing addresses, show the FULL raw address, not truncated.
- When showing amounts, just write "1.5 TON" without formatting tags.

IMPORTANT ACTION DISAMBIGUATION:
- "transaction history" or "recent transactions" → use get_transaction_history (returns recent events/transfers)
- "balance history" or "equity curve" or "balance over time" → use get_equity_curve (returns daily balance snapshots)
- "portfolio" or "PnL" or "performance" → use get_portfolio_metrics
- Do NOT use get_equity_curve when the user asks for transactions.

ADDRESSES:
- When showing TON addresses, always show the FULL address, not truncated.
- After the address, add a Tonviewer link: ${viewerBase}/FULL_ADDRESS`;
  }

  // ── x402 server ──
  const app = express();
  const replayStore = new MemoryReplayStore();
  const userReplayStores = new Map<number, MemoryReplayStore>();
  function getReplayStore(uid: number): MemoryReplayStore {
    if (!userReplayStores.has(uid)) userReplayStores.set(uid, new MemoryReplayStore());
    return userReplayStores.get(uid)!;
  }

  const X402_SERVICES: Record<string, { action: string; params: Record<string, any>; price: string; description: string }> = {
    price: { action: "get_price", params: { token: "TON" }, price: "0.005", description: "TON price data" },
    analytics: { action: "get_portfolio_metrics", params: { days: 7 }, price: "0.01", description: "7-day portfolio" },
    balance: { action: "get_balance", params: {}, price: "0.002", description: "Balance check" },
  };

  app.get("/", (_req, res) => {
    const eps: any[] = [];
    for (const [p, c] of endpointRoutes) eps.push({ path: p, price: c.price + " TON", description: c.description, served: c.served });
    res.json({
      name: "TON Agent Kit Bot",
      network: NETWORK,
      mode: "multi-user",
      activeEndpoints: eps,
      services: Object.entries(X402_SERVICES).map(([k, v]) => ({ service: k, price: v.price + " TON", path: `/u/{uid}/api/${k}` })),
    });
  });

  // Per-user x402 path routing
  app.get("/u/:uid/api/:service", async (req: any, res: any) => {
    const uid = parseInt(req.params.uid);
    const service = req.params.service;
    if (isNaN(uid)) return res.status(400).json({ error: "Invalid user ID" });
    const walletAddr = secretStore.getWalletAddress(uid);
    if (!walletAddr) return res.status(404).json({ error: "User not found" });
    const config = X402_SERVICES[service];
    if (!config) return res.status(404).json({ error: "Unknown service", available: Object.keys(X402_SERVICES) });
    tonPaywall({ recipient: walletAddr, amount: config.price, network: NETWORK, replayStore: getReplayStore(uid) })(req, res, async () => {
      try {
        const userAgent = await getUserAgent(uid);
        const data = await userAgent.runAction(config.action, config.params);
        res.json({ service, data, provider: uid, timestamp: new Date().toISOString() });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });
  });

  // Legacy endpoint routes (dev agent)
  app.use(async (req: any, res: any, next: any) => {
    const route = endpointRoutes.get(req.path);
    if (!route) return next();
    tonPaywall({ amount: route.price, recipient: devAddress, network: NETWORK, description: route.description, replayStore })(req, res, async () => {
      try {
        const merged: Record<string, any> = { ...route.dataParams };
        for (const [k, v] of Object.entries(req.query)) { if (typeof v === "string" && v.length > 0) merged[k] = v; }
        const data = await readOnlyAgent.runAction(route.dataAction, merged);
        route.served++;
        res.json({ source: "telegram-bot", fetchedAt: new Date().toISOString(), ...data });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });
  });
  app.use((_req: any, res: any) => { res.status(404).json({ error: "No endpoint here", available: Array.from(endpointRoutes.keys()) }); });
  const x402Server = app.listen(X402_PORT);

  // ── Helpers ──
  async function safeReply(ctx: any, text: string, extra?: any) {
    try {
      await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
    } catch {
      // FIX #4: Double-fallback: strip tags → generic message
      try {
        await ctx.reply(text.replace(/<[^>]+>/g, ""), {
          link_preview_options: { is_disabled: true },
          ...extra,
        });
      } catch {
        await ctx.reply("Done. (response too complex to display)");
      }
    }
  }

  async function requestApproval(chatId: number, action: string, params: any): Promise<boolean> {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const kb = new InlineKeyboard().text("✅ Approve", `approve_${id}`).text("❌ Reject", `reject_${id}`);
    let msg = `🔔 <b>Approval required</b>\n\n`;
    if (action === "transfer_ton") msg += `📤 <b>Transfer</b>\n├ 💰 <b>${formatTon(params.amount)} TON</b>\n└ 📍 <code>${escapeHtml(shortAddr(params.to || ""))}</code>`;
    else if (action === "create_escrow") msg += `🔒 <b>Create Escrow</b>\n├ 💰 <b>${formatTon(params.amount)} TON</b>\n└ 👤 <code>${escapeHtml(shortAddr(params.beneficiary || ""))}</code>`;
    else if (action.startsWith("swap_")) msg += `🔄 <b>Swap</b>\n├ ${escapeHtml(params.fromToken || "TON")} → ${escapeHtml(params.toToken || "?")}\n└ 💰 ${escapeHtml(params.amount || "?")}`;
    else if (action === "broadcast_intent") msg += `📡 <b>Broadcast Intent</b>\n├ 🏷️ ${escapeHtml(params.service || "?")}\n└ 💰 ${escapeHtml(params.budget || "?")} TON`;
    else if (action === "send_offer") msg += `📨 <b>Send Offer</b>\n├ 📡 Intent #${params.intentIndex || "?"}\n├ 💰 ${escapeHtml(params.price || "?")} TON\n└ ⏱️ ${params.deliveryTime || "?"} min`;
    else if (action === "settle_deal") msg += `✅ <b>Settle Deal</b>\n├ 📡 Intent #${params.intentIndex || "?"}\n└ ⭐ ${params.rating || "?"}/100`;
    else if (action === "vote_release" || action === "vote_refund") msg += `⚖️ <b>${action === "vote_release" ? "Vote Release 💚" : "Vote Refund 🔴"}</b>\n└ 🔒 <code>${escapeHtml(params.escrowId || "?")}</code>`;
    else if (action === "confirm_delivery") msg += `📦 <b>Confirm Delivery</b>\n└ 🔒 <code>${escapeHtml(params.escrowId || "?")}</code>`;
    else msg += `⚡ <b>${escapeHtml(action)}</b>\n<code>${escapeHtml(JSON.stringify(params).slice(0, 200))}</code>`;
    await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", reply_markup: kb });
    return new Promise((resolve) => {
      pendingApprovals.set(id, { chatId, action, params, resolve });
      setTimeout(() => { if (pendingApprovals.has(id)) { pendingApprovals.delete(id); resolve(false); } }, 120000);
    });
  }

  // ── File handling for action results ──
  async function handleActionResult(
    uid: number, chatId: number, action: string, result: any,
  ): Promise<{ summary: string; fileId: string | null }> {
    if (result === null || result === undefined) return { summary: "null", fileId: null };
    if (result?.error) return { summary: JSON.stringify(result), fileId: null };

    // Binary response with content-type (e.g. from pay_for_resource)
    if (result?.contentType && result?.data) {
      const ct = result.contentType as string;
      const buf = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data);
      if (buf.length > MAX_FILE_SIZE) {
        return { summary: JSON.stringify({ error: `Response too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Max 10 MB.` }), fileId: null };
      }
      try {
        if (ct.startsWith("image/")) {
          const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
          const fileId = fileStore.save(uid, `${action}.${ext}`, ct, buf, action);
          try { await bot.api.sendPhoto(chatId, new InputFile(buf, `${action}.${ext}`), { caption: `${action} (saved for 48h)` }); } catch {}
          return { summary: JSON.stringify({ type: "image", fileId, size: `${(buf.length / 1024).toFixed(1)} KB`, sent: true }), fileId };
        }
        if (ct.startsWith("audio/")) {
          const ext = ct.includes("ogg") ? "ogg" : ct.includes("wav") ? "wav" : "mp3";
          const fileId = fileStore.save(uid, `${action}.${ext}`, ct, buf, action);
          try { await bot.api.sendAudio(chatId, new InputFile(buf, `${action}.${ext}`), { caption: `${action} (saved for 48h)` }); } catch {}
          return { summary: JSON.stringify({ type: "audio", fileId, size: `${(buf.length / 1024).toFixed(1)} KB`, sent: true }), fileId };
        }
        const subtype = ct.split("/")[1] || "bin";
        const fileId = fileStore.save(uid, `${action}.${subtype}`, ct, buf, action);
        try { await bot.api.sendDocument(chatId, new InputFile(buf, `${action}.${subtype}`), { caption: `${action} (saved for 48h)` }); } catch {}
        return { summary: JSON.stringify({ type: "document", fileId, size: `${(buf.length / 1024).toFixed(1)} KB`, sent: true }), fileId };
      } catch (err: any) {
        return { summary: JSON.stringify({ error: `File storage failed: ${err.message}` }), fileId: null };
      }
    }

    // JSON response
    const jsonStr = JSON.stringify(result);
    if (jsonStr.length < 4000) {
      let fileId: string | null = null;
      try { fileId = fileStore.save(uid, `${action}.json`, "application/json", Buffer.from(JSON.stringify(result, null, 2)), action); } catch {}
      return { summary: jsonStr, fileId };
    }
    // Large JSON — truncate for LLM, save full version
    let fileId: string | null = null;
    try { fileId = fileStore.save(uid, `${action}.json`, "application/json", Buffer.from(JSON.stringify(result, null, 2)), action); } catch {}
    const truncated = jsonStr.slice(0, 3500) + `\n... (${(jsonStr.length / 1024).toFixed(1)} KB total${fileId ? ", saved as file" : ""})`;
    return { summary: truncated, fileId };
  }

  // ── LLM tool loop (shared by normal + auto mode) ──
  async function executeLLMLoop(
    uid: number,
    chatId: number,
    history: OpenAI.ChatCompletionMessageParam[],
    maxIter: number,
    onStep?: (step: number, action: string) => Promise<void>,
  ): Promise<string> {
    const userAI = getUserOpenAI(uid);
    if (!userAI) {
      throw new Error("No AI key configured. Set one up in Settings → AI Provider.");
    }
    const userAgent = await getUserAgent(uid);
    const tools = userAgent.toAITools();

    await bot.api.sendChatAction(chatId, "typing");
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
        if (!READ_ONLY_ACTIONS.has(fn) && !secretStore.hasWallet(uid)) {
          history.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "This action requires a wallet. Set one up in Settings." }) });
          continue;
        }

        const state = getState(uid);
        const mode = state.confirmTrades ? "confirm" : "auto";
        let approved = true;
        if (needsApproval(fn, fp, mode)) approved = await requestApproval(chatId, fn, fp);

        let result: string;
        if (approved) {
          try {
            await bot.api.sendChatAction(chatId, "typing");
            const ar = await userAgent.runAction(fn, fp);
            const stored = await handleActionResult(uid, chatId, fn, ar);
            result = stored.summary;
            // pay_for_resource receipt
            if (fn === "pay_for_resource" && stored.fileId) {
              try { await bot.api.sendMessage(chatId, `<b>Paid</b> for ${escapeHtml(fp.url || "service")}\nFile saved (48h): ${stored.fileId}\nView in Files`, { parse_mode: "HTML" }); } catch {}
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
                const userAddr = secretStore.getWalletAddress(uid) || devFriendlyAddr;
                result = JSON.stringify({ ...ar, explorerUrl: h ? `${viewerBase}/transaction/${h}` : `${viewerBase}/${userAddr}`, confirmed: !!h });
              } catch { result = JSON.stringify({ ...ar, explorerUrl: `${viewerBase}/${secretStore.getWalletAddress(uid) || devFriendlyAddr}` }); }
            }
          } catch (err: any) { result = JSON.stringify({ error: err.message }); }
        } else {
          result = JSON.stringify({ status: "rejected", reason: "User rejected" });
        }
        history.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
      await bot.api.sendChatAction(chatId, "typing");
      response = await userAI.client.chat.completions.create({ model: userAI.model, messages: history, tools, tool_choice: "auto" });
      am = response.choices[0].message;
    }
    } catch (loopErr: any) {
      // FIX #2: Chat history corrupted → reset and inform
      if (loopErr.message?.includes("tool_call_id") || loopErr.message?.includes("tool_calls")) {
        chatHistories.delete(chatId);
        throw new Error("Chat history was corrupted. Please try again.");
      }
      throw loopErr;
    }
    const reply = am.content || "Done!";
    history.push({ role: "assistant", content: reply });
    return reply;
  }

  // ── handleNormalMessage (extracted from old message:text) ──
  async function handleNormalMessage(ctx: any, text: string) {
    const uid = ctx.from!.id;
    const chatId = ctx.chat.id;
    if (!getUserOpenAI(uid)) {
      await safeReply(ctx, `⚠️ <b>No AI key configured.</b>\n\nSet one up in Settings → AI Provider.`, {
        reply_markup: new InlineKeyboard().text("Set up AI key", "setup_ai_provider").text("Settings", "btn_settings"),
      });
      return;
    }
    userLocks.set(uid, true);
    const userAddr = secretStore.getWalletAddress(uid) || devFriendlyAddr;
    const sysPrompt = makeSystemPrompt(uid, userAddr);
    if (!chatHistories.has(chatId)) chatHistories.set(chatId, [{ role: "system", content: sysPrompt }]);
    const history = chatHistories.get(chatId)!;
    history.push({ role: "user", content: text });
    if (history.length > 40) history.splice(1, history.length - 39);
    try {
      const reply = await executeLLMLoop(uid, chatId, history, 5);
      await safeReply(ctx, reply);
    } catch (err: any) {
      console.error("Error:", err.message);
      chatHistories.delete(chatId);
      await safeReply(ctx, `⚠️ <b>Error:</b> ${escapeHtml(err.message.slice(0, 200))}`);
    } finally {
      userLocks.set(uid, false);
    }
  }

  // ── Auto Mode handler ──
  async function handleAutoMode(ctx: any, state: UserState, goal: string) {
    const uid = ctx.from!.id;
    if (!getUserOpenAI(uid)) {
      await safeReply(ctx, `⚠️ <b>No AI key configured.</b>\n\nSet one up in Settings → AI Provider.`, {
        reply_markup: new InlineKeyboard().text("Set up AI key", "setup_ai_provider").text("Settings", "btn_settings"),
      });
      return;
    }
    userLocks.set(uid, true);
    state.autoRunning = true;
    state.autoGoal = goal;
    const chatId = ctx.chat!.id;
    const statusMsg = await ctx.reply(
      `<b>🤖 Mission started</b>\n\nGoal: <i>${escapeHtml(goal.slice(0, 200))}</i>\n\n<i>Working...</i>`,
      { parse_mode: "HTML" },
    );
    try {
      const userAddr = secretStore.getWalletAddress(uid) || devFriendlyAddr;
      const sysPrompt = makeSystemPrompt(uid, userAddr);
      const missionHistory: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: sysPrompt + "\n\nMISSION MODE: Execute the following mission autonomously. Be decisive. Report results concisely." },
        { role: "user", content: goal },
      ];
      let stepCount = 0;
      const reply = await executeLLMLoop(uid, chatId, missionHistory, state.maxAutoSteps, async (step, action) => {
        stepCount = step;
        try {
          await bot.api.editMessageText(chatId, statusMsg.message_id,
            `<b>🤖 Mission in progress</b>\n\nGoal: <i>${escapeHtml(goal.slice(0, 100))}</i>\n\nStep ${step}/${state.maxAutoSteps}: <code>${escapeHtml(action)}</code>...`,
            { parse_mode: "HTML" });
        } catch {}
      });
      state.autoRunning = false;
      state.autoMode = false;
      await bot.api.editMessageText(chatId, statusMsg.message_id,
        `<b>✅ Mission complete!</b>\n\n${escapeHtml(reply.slice(0, 500))}\n\nSteps: ${stepCount}\n<i>Auto mode off.</i>`,
        { parse_mode: "HTML", reply_markup: mainMenuKb() });
    } catch (err: any) {
      state.autoRunning = false;
      state.autoMode = false;
      await bot.api.editMessageText(chatId, statusMsg.message_id,
        `<b>❌ Mission failed</b>\n\n${escapeHtml((err.message || "Unknown error").slice(0, 300))}\n\n<i>Auto mode off.</i>`,
        { parse_mode: "HTML", reply_markup: mainMenuKb() });
    } finally {
      userLocks.set(uid, false);
    }
  }

  // ── Listen Mode ──
  function startListening(uid: number) {
    const state = getState(uid);
    if (state.listenTimer) clearInterval(state.listenTimer);
    state.seenIntentIds = new Set();
    state.lastPollCount = 0;
    pollIntents(uid);
    state.listenTimer = setInterval(() => pollIntents(uid), state.pollInterval);
  }

  function stopListening(uid: number) {
    const state = getState(uid);
    if (state.listenTimer) { clearInterval(state.listenTimer); state.listenTimer = undefined; }
    state.listenMode = false;
  }

  async function pollIntents(uid: number) {
    const state = getState(uid);
    try {
      const userAgent = await getUserAgent(uid);
      const filter: any = state.listenFilter ? { service: state.listenFilter } : {};
      const result = (await userAgent.runAction("discover_intents", filter)) as any;
      const intents = result?.intents || [];
      const newOnes = intents.filter((i: any) => !state.seenIntentIds.has(i.intentIndex));
      for (const i of intents) state.seenIntentIds.add(i.intentIndex);

      if (newOnes.length > 0) {
        const byService: Record<string, number> = {};
        for (const i of intents) { const svc = i.serviceName || i.service || "unknown"; byService[svc] = (byService[svc] || 0) + 1; }
        const topServices = Object.entries(byService).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => `${s} (${c})`).join(", ");
        await bot.api.sendMessage(uid,
          `<b>👂 Listen Mode</b> — update\n\n${intents.length} active intents\n<b>${newOnes.length} new</b> since last check\n\nTop: ${topServices}`,
          { parse_mode: "HTML", reply_markup: listenKb(newOnes.length) });
      }
      state.lastPollCount = intents.length;

      // Also poll offers on user's own intents
      await pollMyOffers(uid);
    } catch {}
  }

  async function pollMyOffers(uid: number) {
    const state = getState(uid);
    const userAgent = await getUserAgent(uid);
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
            msg += `Seller: <code>${shortAddr(o.seller || "")}</code>\n\n`;
          }
          const kb = new InlineKeyboard();
          for (const o of newOffers.slice(0, 3)) kb.text(`Accept #${o.offerIndex}`, `accept_offer_${o.offerIndex}`).row();
          kb.text("View All", `view_intent_${intentIdx}`).text("« Back", "btn_main");
          await bot.api.sendMessage(uid, msg, { parse_mode: "HTML", reply_markup: kb });
        }
      } catch {}
    }
  }

  // ── Offer Tracking ──
  function startOfferTracking(uid: number) {
    const state = getState(uid);
    if (state.offerTrackTimer) return;
    state.offerTrackTimer = setInterval(async () => {
      if (state.pendingOffers.size === 0) { clearInterval(state.offerTrackTimer!); state.offerTrackTimer = undefined; return; }
      const userAgent = await getUserAgent(uid);
      for (const [offerIdx, info] of state.pendingOffers) {
        try {
          const offers = (await userAgent.runAction("get_offers", { intentIndex: info.intentIndex })) as any;
          const offer = (offers?.offers || []).find((o: any) => o.offerIndex === offerIdx);
          if (!offer) continue;
          if (offer.status === 1) {
            state.pendingOffers.delete(offerIdx);
            await bot.api.sendMessage(uid, `<b>✅ Offer accepted!</b>\n\nYour offer #${offerIdx} on intent #${info.intentIndex} was accepted!`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
          } else if (offer.status === 2 || offer.status === 3) {
            state.pendingOffers.delete(offerIdx);
            await bot.api.sendMessage(uid, `<b>${offer.status === 2 ? "❌ Offer rejected" : "⏰ Offer expired"}</b>\n\nOffer #${offerIdx} on intent #${info.intentIndex}.`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
          }
        } catch {}
      }
    }, 15000);
  }

  // ══════════════════════════════════════
  // ══ HITL CALLBACKS (preserved) ═══════
  // ══════════════════════════════════════
  bot.callbackQuery(/^approve_(.+)$/, async (ctx) => {
    const p = pendingApprovals.get(ctx.match![1]);
    if (p) { p.resolve(true); pendingApprovals.delete(ctx.match![1]); await ctx.editMessageText("✅ <b>Approved</b> — executing...", { parse_mode: "HTML" }); }
    else { await ctx.editMessageText("⚠️ Expired.", { parse_mode: "HTML" }); }
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery(/^reject_(.+)$/, async (ctx) => {
    const p = pendingApprovals.get(ctx.match![1]);
    if (p) { p.resolve(false); pendingApprovals.delete(ctx.match![1]); await ctx.editMessageText("❌ <b>Rejected</b>", { parse_mode: "HTML" }); }
    else { await ctx.editMessageText("⚠️ Expired.", { parse_mode: "HTML" }); }
    await ctx.answerCallbackQuery();
  });

  // ── Onboarding helper ──
  async function showOnboarding(ctx: any, uid: number, edit = false) {
    const hasW = secretStore.hasWallet(uid);
    const hasA = secretStore.hasApiKey(uid);
    const kb = new InlineKeyboard();
    if (!hasW) {
      kb.text("🔑 Generate new wallet", "setup_wallet_generate").row();
      kb.text("📥 Import mnemonic", "setup_wallet_import").row();
    }
    if (!hasA) {
      kb.text("🧠 Set up AI key", "setup_ai_provider").row();
    }
    kb.text("⏭️ Skip for now", "setup_skip");
    let msg = `<b>🤖 TON Agent Kit</b>\n\n`;
    msg += `<b>Step 1: Wallet</b> ${hasW ? "✅" : "⬜"}\nTransfer, trade, escrow, sell services\n\n`;
    msg += `<b>Step 2: AI Key</b> ${hasA ? "✅" : "⬜"}\nChat, auto mode, complex commands\n\n`;
    msg += `<i>Without wallet:</i> read-only (browse prices, agents, intents)\n`;
    msg += `<i>Without AI key:</i> buttons work, chat does not`;
    if (edit) {
      await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: kb });
    } else {
      await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
    }
  }

  // ══════════════════════════════════════
  // ══ /start COMMAND ═══════════════════
  // ══════════════════════════════════════
  bot.command("start", async (ctx) => {
    const uid = ctx.from!.id;
    const state = getState(uid);
    const hasW = secretStore.hasWallet(uid);
    const hasA = secretStore.hasApiKey(uid);

    if (hasW && hasA) {
      // Returning user — show main menu with their balance
      state.walletReady = true;
      state.aiReady = true;
      const userAgent = await getUserAgent(uid);
      const walletAddr = secretStore.getWalletAddress(uid)!;
      let bal = "?";
      try { bal = formatTon(((await userAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
      const sent = await ctx.reply(
        `<b>🤖 TON Agent Kit</b>\n\n` +
        `<code>${escapeHtml(walletAddr)}</code> <i>(tap to copy)</i>\n` +
        `Balance: <b>${bal} TON</b> · ${NETWORK}\n\n` +
        `⚡ ${userAgent.getAvailableActions().length} actions · x402: ${publicUrl}\n\n` +
        `Tap any button below.`,
        { parse_mode: "HTML", reply_markup: mainMenuKb() },
      );
      state.mainMessageId = sent.message_id;
      state.currentMenu = "main";
    } else {
      await showOnboarding(ctx, uid);
    }
  });

  // ══════════════════════════════════════
  // ══ ONBOARDING CALLBACKS ═════════════
  // ══════════════════════════════════════

  bot.callbackQuery("setup_wallet_generate", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    try {
      const words = await mnemonicNew(24);
      const wallet = await KeypairWallet.fromMnemonic(words, { network: NETWORK, version: "V5R1" });
      const addr = wallet.address.toRawString();
      secretStore.saveWallet(uid, words.join(" "), addr);
      getState(uid).walletReady = true;
      userAgents.delete(uid);

      // Format 24 words in 4 lines of 6
      const lines: string[] = [];
      for (let i = 0; i < 24; i += 6) {
        lines.push(words.slice(i, i + 6).map((w, j) => `${i + j + 1}. ${w}`).join("  "));
      }
      await ctx.editMessageText(
        `<b>🔑 Your wallet is ready!</b>\n\n` +
        `<b>Save these 24 words securely:</b>\n\n` +
        `<code>${escapeHtml(lines.join("\n"))}</code>\n\n` +
        `⚠️ <b>This is the ONLY time you'll see them.</b>\nAnyone with these words can access your funds.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✅ I saved them", "setup_wallet_saved") },
      );
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ Failed to generate wallet: ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Try again", "setup_wallet_generate").text("« Back", "setup_back") });
    }
  });

  bot.callbackQuery("setup_wallet_saved", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    try { await ctx.deleteMessage(); } catch {}
    const addr = secretStore.getWalletAddress(uid);
    const kb = new InlineKeyboard();
    if (!secretStore.hasApiKey(uid)) kb.text("🧠 Set up AI key", "setup_ai_provider").row();
    kb.text("🏠 Main menu", "btn_main");
    await ctx.reply(
      `<b>✅ Wallet saved!</b>\n\n📍 <code>${escapeHtml(addr || "?")}</code>\n🌐 ${NETWORK}\n\n<i>Send ${NETWORK === "testnet" ? "testnet" : ""} TON to this address to start.</i>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery("setup_wallet_import", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    state.awaitingMnemonic = true;
    await ctx.editMessageText(
      `<b>📥 Import Wallet</b>\n\nSend me your 24-word mnemonic.\n\n⚠️ <b>Your message will be deleted immediately.</b>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Cancel", "setup_back") },
    );
  });

  bot.callbackQuery("setup_ai_provider", async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    for (const [key, p] of Object.entries(LLM_PROVIDERS)) {
      kb.text(p.name, `setup_ai_key_${key}`).row();
    }
    kb.text("« Back", "setup_back");
    await ctx.editMessageText(
      `<b>🧠 Choose AI Provider</b>\n\nAll providers use OpenAI-compatible API.\nYou bring your own key — the bot operator pays $0.\n\n<i>Pick one:</i>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  for (const [providerKey, provider] of Object.entries(LLM_PROVIDERS)) {
    bot.callbackQuery(`setup_ai_key_${providerKey}`, async (ctx) => {
      await ctx.answerCallbackQuery();
      const uid = ctx.from!.id;
      const state = getState(uid);
      state.awaitingApiKey = true;
      state.pendingProvider = providerKey;
      await ctx.editMessageText(
        `<b>🧠 ${escapeHtml(provider.name)}</b>\n\n` +
        `Get your API key: ${provider.keyUrl}\n\n` +
        `<b>Send me your API key.</b>\n⚠️ Your message will be deleted immediately.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Cancel", "setup_ai_provider") },
      );
    });
  }

  bot.callbackQuery(/^setup_ai_model_([a-z]+)_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Validating...");
    const uid = ctx.from!.id;
    const state = getState(uid);
    const providerKey = ctx.match![1];
    const modelId = ctx.match![2];
    const apiKey = (state as any)._tempApiKey;
    if (!apiKey) {
      await ctx.editMessageText(`⚠️ Session expired. Please start over.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Set up AI key", "setup_ai_provider") });
      return;
    }
    const provider = LLM_PROVIDERS[providerKey];
    try {
      const testClient = new OpenAI({ apiKey, baseURL: provider?.baseURL });
      await testClient.chat.completions.create({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
      // Success
      secretStore.saveApiKey(uid, providerKey, modelId, apiKey);
      delete (state as any)._tempApiKey;
      state.pendingProvider = undefined;
      state.aiReady = true;
      userOpenAIClients.delete(uid);
      chatHistories.delete(ctx.chat!.id);
      const kb = new InlineKeyboard();
      if (!secretStore.hasWallet(uid)) kb.text("🔑 Set up wallet", "setup_wallet_generate").row();
      kb.text("🏠 Main menu", "btn_main");
      await ctx.editMessageText(
        `<b>✅ AI configured!</b>\n\n🧠 Provider: <b>${escapeHtml(provider?.name || providerKey)}</b>\n🤖 Model: <b>${escapeHtml(modelId)}</b>`,
        { parse_mode: "HTML", reply_markup: kb },
      );
    } catch (err: any) {
      const status = err?.status || err?.response?.status;
      let hint = err.message?.slice(0, 200) || "Unknown error";
      if (status === 401) hint = "Invalid API key";
      else if (status === 403) hint = "No access to this model";
      else if (status === 404) hint = `Model not found: ${modelId}`;
      else if (status === 429) hint = "Rate limited. Wait and try again";
      await ctx.editMessageText(
        `<b>❌ Validation failed</b>\n\n${escapeHtml(hint)}\n\n<i>Try again or pick a different model.</i>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🔄 Try again", `setup_ai_key_${providerKey}`).text("« Providers", "setup_ai_provider") },
      );
    }
  });

  bot.callbackQuery("setup_skip", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    state.currentMenu = "main";
    let bal = "?";
    try { bal = formatTon(((await readOnlyAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
    await ctx.editMessageText(
      `<b>🤖 TON Agent Kit</b>\n\n` +
      `Balance: <b>${bal} TON</b> · ${NETWORK}\n\n` +
      `<i>Some features need a wallet and AI key.\nSet them up anytime in Settings.</i>`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  bot.callbackQuery("setup_back", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    state.awaitingMnemonic = false;
    state.awaitingApiKey = false;
    state.pendingProvider = undefined;
    delete (state as any)._tempApiKey;
    await showOnboarding(ctx, uid, true);
  });

  // ══════════════════════════════════════
  // ══ MAIN MENU CALLBACKS ══════════════
  // ══════════════════════════════════════

  bot.callbackQuery("btn_main", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const hasW = secretStore.hasWallet(uid);
    let bal = "—";
    let walletAddr = "No wallet";
    if (hasW) {
      const userAgent = await getUserAgent(uid);
      walletAddr = secretStore.getWalletAddress(uid)!;
      try { bal = formatTon(((await userAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
    }
    await ctx.editMessageText(
      `<b>🤖 TON Agent Kit</b>\n\n<code>${escapeHtml(walletAddr)}</code>\nBalance: <b>${bal} TON</b> · ${NETWORK}\n\nTap any button below.`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  bot.callbackQuery("btn_balance", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    if (!secretStore.hasWallet(uid)) {
      await ctx.editMessageText(
        `<b>💎 Balance</b>\n\n<i>No wallet configured.</i>\nSet one up to see your balance.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Set up wallet", "settings_wallet").text("« Back", "btn_main") },
      );
      return;
    }
    const userAgent = await getUserAgent(uid);
    const walletAddr = secretStore.getWalletAddress(uid)!;
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
      `<b>💎 Balance</b>\n\n<b>${bal} TON</b>${priceInfo}\n\n<a href="${viewerBase}/${escapeHtml(walletAddr)}">🔗 Tonviewer ↗</a>`,
      { parse_mode: "HTML", reply_markup: mainMenuKb(), link_preview_options: { is_disabled: true } } as any,
    );
  });

  bot.callbackQuery("btn_refresh", async (ctx) => {
    await ctx.answerCallbackQuery("Refreshing...");
    const uid = ctx.from!.id;
    const hasW = secretStore.hasWallet(uid);
    let bal = "—";
    let walletAddr = "No wallet";
    if (hasW) {
      const userAgent = await getUserAgent(uid);
      walletAddr = secretStore.getWalletAddress(uid)!;
      try { bal = formatTon(((await userAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
    }
    await ctx.editMessageText(
      `<b>🤖 TON Agent Kit</b>\n\n<code>${escapeHtml(walletAddr)}</code>\nBalance: <b>${bal} TON</b> · ${NETWORK}\n\nTap any button below.`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  bot.callbackQuery("btn_transfer", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.awaitingInput = "transfer";
    state.currentMenu = "main";
    await ctx.editMessageText(
      `<b>📤 Transfer</b>\n\nType your transfer request:\n\n<i>"Send 0.1 TON to EQ..."</i>\n<i>"Transfer 5 USDT to 0:abc..."</i>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Back", "btn_main") },
    );
  });

  bot.callbackQuery("btn_swap", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.awaitingInput = "swap";
    state.currentMenu = "main";
    await ctx.editMessageText(
      `<b>🔄 Swap</b>\n\nType your swap request:\n\n<i>"Swap 1 TON to USDT"</i>\n<i>"Buy 10 USDT with TON"</i>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Back", "btn_main") },
    );
  });

  bot.callbackQuery("btn_portfolio", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const userAgent = await getUserAgent(ctx.from!.id);
      const r = (await userAgent.runAction("get_portfolio_metrics", { days: 7 })) as any;
      await ctx.editMessageText(
        `<b>📊 Portfolio (7d)</b>\n\n📈 PnL: <b>${r.netPnL || "0"} TON</b>\n📊 ROI: <b>${r.roi || "0"}%</b>\n🏆 Win: <b>${r.winRate || "0"}%</b>\n📉 Drawdown: <b>${r.maxDrawdown || "0"} TON</b>\n🔄 TXs: <b>${r.totalTransactions || 0}</b>\n💎 Balance: <b>${r.currentBalance || "?"} TON</b>`,
        { parse_mode: "HTML", reply_markup: mainMenuKb() },
      );
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  bot.callbackQuery("btn_help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>❓ TON Agent Kit</b> · ${readOnlyAgent.getAvailableActions().length} actions\n\n` +
      `━━━ <b>💰 Wallet</b> ━━━━━━━━━━\nBalance, transfers, jettons\n\n` +
      `━━━ <b>📈 DeFi</b> ━━━━━━━━━━━━\nSwaps, prices, yield\n\n` +
      `━━━ <b>🔒 Escrow</b> ━━━━━━━━━━\nDeals, deposits, disputes\n\n` +
      `━━━ <b>🤝 Agents</b> ━━━━━━━━━━\nRegister, discover, reputation\n\n` +
      `━━━ <b>🌐 x402</b> ━━━━━━━━━━━━\nPaid data endpoints\n\n` +
      `<i>Use buttons or type naturally.</i>`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  bot.callbackQuery("btn_wallet_info", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    if (!secretStore.hasWallet(uid)) {
      await ctx.editMessageText(
        `💎 <b>Wallet</b>\n\n<i>No wallet configured.</i>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Set up wallet", "settings_wallet").text("« Back", "btn_settings") },
      );
      return;
    }
    const userAgent = await getUserAgent(uid);
    const walletAddr = secretStore.getWalletAddress(uid)!;
    let bal = "?";
    try { bal = formatTon(((await userAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
    await ctx.editMessageText(
      `💎 <b>Wallet</b>\n\n📍 <code>${escapeHtml(walletAddr)}</code>\n💰 Balance: <b>${bal} TON</b>\n🌐 ${NETWORK === "testnet" ? "🧪 Testnet" : "🌐 Mainnet"}\n\n<a href="${viewerBase}/${escapeHtml(walletAddr)}">🔗 Tonviewer ↗</a>`,
      { parse_mode: "HTML", reply_markup: settingsKb(getState(uid)), link_preview_options: { is_disabled: true } } as any,
    );
  });

  bot.callbackQuery(/^btn_agents(?:_(\d+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userAgent = await getUserAgent(ctx.from!.id);
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

  bot.callbackQuery("btn_escrow", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userAgent = await getUserAgent(ctx.from!.id);
    let msg = `<b>🔒 Escrow</b>\n\n`;
    let has = false;
    if (endpointRoutes.size) {
      msg += `━━━ <b>🌐 Endpoints</b> ━━━\n`;
      for (const [p, c] of endpointRoutes) msg += `• ${escapeHtml(p)} → ${escapeHtml(c.dataAction)} (${c.served}x)\n`;
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

  bot.callbackQuery("btn_offers", async (ctx) => {
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

  bot.callbackQuery("btn_intents", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    const userAgent = await getUserAgent(uid);
    state.currentMenu = "intents";
    try {
      const myAddr = secretStore.getWalletAddress(uid) || devAddress;
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

  bot.callbackQuery("btn_intents_refresh", async (ctx) => {
    // Same as btn_intents
    await ctx.answerCallbackQuery("Refreshing...");
    const uid = ctx.from!.id;
    const state = getState(uid);
    const userAgent = await getUserAgent(uid);
    try {
      const allIntents = (await userAgent.runAction("discover_intents", {})) as any;
      const intents = allIntents?.intents || [];
      const myAddr = secretStore.getWalletAddress(uid) || devAddress;
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

  bot.callbackQuery("btn_browse", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const userAgent = await getUserAgent(ctx.from!.id);
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

  bot.callbackQuery(/^browse_page_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userAgent = await getUserAgent(ctx.from!.id);
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

  bot.callbackQuery("btn_new_intent", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.awaitingInput = "new_intent";
    await ctx.editMessageText(
      `<b>📡 New Intent</b>\n\nDescribe what service you need:\n\n<i>"I need a price feed for TON/USDT"</i>\n<i>"Looking for analytics data, budget 0.5 TON"</i>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Back", "btn_intents") },
    );
  });

  bot.callbackQuery("btn_my_offers", async (ctx) => {
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

  bot.callbackQuery(/^view_intent_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userAgent = await getUserAgent(ctx.from!.id);
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

  bot.callbackQuery(/^offer_(\d+)$/, async (ctx) => {
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

  bot.callbackQuery(/^price_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    if (!state.offerDraft) return;
    state.offerDraft.price = ctx.match![1];
    await ctx.editMessageText(
      `<b>📨 Offer on Intent #${state.offerDraft.intentIndex}</b>\n\nPrice: <b>${state.offerDraft.price} TON</b>\nDelivery: <b>${state.offerDraft.deliveryTime} min</b>\n\nTap to change, or type a custom amount.`,
      { parse_mode: "HTML", reply_markup: offerFormKb(state.offerDraft) },
    );
  });

  bot.callbackQuery(/^time_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    if (!state.offerDraft) return;
    state.offerDraft.deliveryTime = parseInt(ctx.match![1]);
    await ctx.editMessageText(
      `<b>📨 Offer on Intent #${state.offerDraft.intentIndex}</b>\n\nPrice: <b>${state.offerDraft.price} TON</b>\nDelivery: <b>${state.offerDraft.deliveryTime} min</b>\n\nTap to change, or type a custom amount.`,
      { parse_mode: "HTML", reply_markup: offerFormKb(state.offerDraft) },
    );
  });

  bot.callbackQuery("btn_send_offer", async (ctx) => {
    await ctx.answerCallbackQuery("Sending offer...");
    const uid = ctx.from!.id;
    const state = getState(uid);
    const draft = state.offerDraft;
    if (!draft) return;
    if (!secretStore.hasWallet(uid)) {
      await ctx.editMessageText(`⚠️ This action requires a wallet. Set one up in Settings.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Set up wallet", "settings_wallet").text("« Back", "btn_main") });
      return;
    }
    try {
      const userAgent = await getUserAgent(uid);
      const result = (await userAgent.runAction("send_offer", {
        intentIndex: draft.intentIndex,
        price: draft.price,
        deliveryTime: draft.deliveryTime,
        endpoint: "pending",
      })) as any;
      if (result?.offerIndex !== undefined) {
        state.pendingOffers.set(result.offerIndex, { intentIndex: draft.intentIndex, sentAt: Date.now() });
        startOfferTracking(uid);
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

  bot.callbackQuery(/^accept_offer_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Accepting offer...");
    const uid = ctx.from!.id;
    if (!secretStore.hasWallet(uid)) {
      await ctx.editMessageText(`⚠️ This action requires a wallet. Set one up in Settings.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Set up wallet", "settings_wallet").text("« Back", "btn_main") });
      return;
    }
    const userAgent = await getUserAgent(uid);
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

  bot.callbackQuery(/^cancel_intent_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Cancelling...");
    const uid = ctx.from!.id;
    if (!secretStore.hasWallet(uid)) {
      await ctx.editMessageText(`⚠️ This action requires a wallet. Set one up in Settings.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Set up wallet", "settings_wallet").text("« Back", "btn_main") });
      return;
    }
    const userAgent = await getUserAgent(uid);
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

  // ══════════════════════════════════════
  // ══ SETTINGS CALLBACKS ═══════════════
  // ══════════════════════════════════════

  bot.callbackQuery("btn_settings", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.currentMenu = "settings";
    await ctx.editMessageText(`<b>⚙️ Settings</b>\n\nConfigure your agent behavior.`, { parse_mode: "HTML", reply_markup: settingsKb(state) });
  });

  bot.callbackQuery("toggle_confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.confirmTrades = !state.confirmTrades;
    await ctx.editMessageText(
      `<b>⚙️ Settings</b>\n\nConfirm Trades: <b>${state.confirmTrades ? "ON" : "OFF"}</b>\n<i>${state.confirmTrades ? "Transfers need approval" : "No approval buttons"}</i>`,
      { parse_mode: "HTML", reply_markup: settingsKb(state) },
    );
  });

  bot.callbackQuery("toggle_auto", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.autoMode = !state.autoMode;
    if (!state.autoMode) state.autoRunning = false;
    await ctx.editMessageText(
      `<b>⚙️ Settings</b>\n\nAuto Mode: <b>${state.autoMode ? "ON" : "OFF"}</b>`,
      { parse_mode: "HTML", reply_markup: settingsKb(state) },
    );
  });

  bot.callbackQuery("toggle_listen", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    state.listenMode = !state.listenMode;
    if (state.listenMode) startListening(uid); else stopListening(uid);
    await ctx.editMessageText(
      `<b>⚙️ Settings</b>\n\nListen Mode: <b>${state.listenMode ? "ON" : "OFF"}</b>`,
      { parse_mode: "HTML", reply_markup: settingsKb(state) },
    );
  });

  bot.callbackQuery("cycle_hitl", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    const vals = [0.05, 0.1, 0.5, 1.0];
    const idx = vals.indexOf(state.hitlThreshold);
    state.hitlThreshold = vals[(idx + 1) % vals.length];
    await ctx.editMessageText(`<b>⚙️ Settings</b>\n\nHITL threshold: <b>${state.hitlThreshold} TON</b>`, { parse_mode: "HTML", reply_markup: settingsKb(state) });
  });

  bot.callbackQuery("cycle_steps", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    const vals = [5, 10, 15, 20];
    const idx = vals.indexOf(state.maxAutoSteps);
    state.maxAutoSteps = vals[(idx + 1) % vals.length];
    await ctx.editMessageText(`<b>⚙️ Settings</b>\n\nMax auto steps: <b>${state.maxAutoSteps}</b>`, { parse_mode: "HTML", reply_markup: settingsKb(state) });
  });

  bot.callbackQuery("cycle_poll", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    const vals = [15000, 30000, 60000];
    const idx = vals.indexOf(state.pollInterval);
    state.pollInterval = vals[(idx + 1) % vals.length];
    if (state.listenMode) { stopListening(uid); startListening(uid); }
    await ctx.editMessageText(`<b>⚙️ Settings</b>\n\nPoll interval: <b>${state.pollInterval / 1000}s</b>`, { parse_mode: "HTML", reply_markup: settingsKb(state) });
  });

  // ══════════════════════════════════════
  // ══ WALLET SETTINGS CALLBACKS ════════
  // ══════════════════════════════════════

  bot.callbackQuery("settings_wallet", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    if (secretStore.hasWallet(uid)) {
      const addr = secretStore.getWalletAddress(uid)!;
      const userAgent = await getUserAgent(uid);
      let bal = "?";
      try { bal = formatTon(((await userAgent.runAction("get_balance", {})) as any).balance || "0"); } catch {}
      await ctx.editMessageText(
        `<b>💰 Wallet</b>\n\n📍 <code>${escapeHtml(addr)}</code>\n💰 <b>${bal} TON</b>\n🌐 ${NETWORK}`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard()
          .text("📤 Export mnemonic", "wallet_export").text("🔄 Change wallet", "wallet_change").row()
          .text("🗑️ Disconnect", "wallet_disconnect").text("« Back", "btn_settings") },
      );
    } else {
      await ctx.editMessageText(
        `<b>💰 Wallet</b>\n\n<i>No wallet configured.</i>\nSet up a wallet to use on-chain features.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard()
          .text("🔑 Generate new", "setup_wallet_generate").text("📥 Import", "setup_wallet_import").row()
          .text("« Back", "btn_settings") },
      );
    }
  });

  bot.callbackQuery("wallet_export", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>⚠️ Export mnemonic?</b>\n\nYour 24-word mnemonic will be shown.\nThe message will be auto-deleted in 30 seconds.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✅ Show mnemonic", "wallet_export_confirm").text("« Cancel", "settings_wallet") },
    );
  });

  bot.callbackQuery("wallet_export_confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const stored = secretStore.loadWallet(uid);
    if (!stored) {
      await ctx.editMessageText(`⚠️ No wallet found.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Back", "settings_wallet") });
      return;
    }
    const words = stored.mnemonic.split(" ");
    const lines: string[] = [];
    for (let i = 0; i < words.length; i += 6) {
      lines.push(words.slice(i, i + 6).map((w, j) => `${i + j + 1}. ${w}`).join("  "));
    }
    const msg = await ctx.editMessageText(
      `<b>🔑 Your mnemonic</b>\n\n<code>${escapeHtml(lines.join("\n"))}</code>\n\n⚠️ <b>This message will be deleted in 30 seconds.</b>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🗑️ Delete now", "settings_wallet") },
    );
    setTimeout(async () => {
      try { await bot.api.deleteMessage(ctx.chat!.id, msg.message_id); } catch {}
    }, 30000);
  });

  bot.callbackQuery("wallet_change", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>🔄 Change Wallet</b>\n\nThis will replace your current wallet.\nMake sure you've backed up your mnemonic.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard()
        .text("🔑 Generate new", "setup_wallet_generate").text("📥 Import", "setup_wallet_import").row()
        .text("« Cancel", "settings_wallet") },
    );
  });

  bot.callbackQuery("wallet_disconnect", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>⚠️ Disconnect wallet?</b>\n\nYou will lose access to your wallet unless you have the mnemonic backed up.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🗑️ Yes, disconnect", "wallet_disconnect_confirm").text("« Cancel", "settings_wallet") },
    );
  });

  bot.callbackQuery("wallet_disconnect_confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    secretStore.deleteWallet(uid);
    userAgents.delete(uid);
    getState(uid).walletReady = false;
    chatHistories.delete(ctx.chat!.id);
    await ctx.editMessageText(
      `<b>✅ Wallet disconnected.</b>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🔑 Set up new wallet", "settings_wallet").text("« Back", "btn_settings") },
    );
  });

  // ══════════════════════════════════════
  // ══ AI SETTINGS CALLBACKS ════════════
  // ══════════════════════════════════════

  bot.callbackQuery("settings_ai", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    if (secretStore.hasApiKey(uid)) {
      const info = secretStore.getApiKeyInfo(uid)!;
      const providerName = LLM_PROVIDERS[info.provider]?.name || info.provider;
      await ctx.editMessageText(
        `<b>🧠 AI Provider</b>\n\n🏢 Provider: <b>${escapeHtml(providerName)}</b>\n🤖 Model: <b>${escapeHtml(info.model)}</b>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard()
          .text("🔄 Change provider", "setup_ai_provider").row()
          .text("🗑️ Remove key", "ai_remove").text("« Back", "btn_settings") },
      );
    } else {
      await ctx.editMessageText(
        `<b>🧠 AI Provider</b>\n\n<i>No AI key configured.</i>\nSet up an AI key to use chat and auto mode.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard()
          .text("🧠 Set up AI key", "setup_ai_provider").text("« Back", "btn_settings") },
      );
    }
  });

  bot.callbackQuery("ai_remove", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>⚠️ Remove AI key?</b>\n\nYou won't be able to use chat or auto mode.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🗑️ Yes, remove", "ai_remove_confirm").text("« Cancel", "settings_ai") },
    );
  });

  bot.callbackQuery("ai_remove_confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    secretStore.deleteApiKey(uid);
    userOpenAIClients.delete(uid);
    getState(uid).aiReady = false;
    chatHistories.delete(ctx.chat!.id);
    await ctx.editMessageText(
      `<b>✅ AI key removed.</b>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🧠 Set up AI key", "setup_ai_provider").text("« Back", "btn_settings") },
    );
  });

  // ══════════════════════════════════════
  // ══ FILES CALLBACKS ══════════════════
  // ══════════════════════════════════════

  async function renderFilesList(ctx: any, uid: number, page: number) {
    fileStore.cleanupExpired();
    const limit = 5;
    const files = fileStore.listFiles(uid, page * limit, limit);
    const total = fileStore.countFiles(uid);
    const storage = fileStore.getUserStorage(uid);
    const now = Math.floor(Date.now() / 1000);

    let msg = `<b>📁 My Files</b> (${total} files, ${(storage / 1024 / 1024).toFixed(1)} / ${MAX_USER_STORAGE / 1024 / 1024} MB)\n\n`;
    if (files.length === 0) {
      msg += `<i>No files stored.</i>\nFiles are saved automatically from action results.`;
    } else {
      for (const f of files) {
        const hoursLeft = Math.max(0, Math.floor((f.expiresAt - now) / 3600));
        const icon = f.contentType.startsWith("image/") ? "🖼️" : f.contentType.startsWith("audio/") ? "🎵" : f.contentType === "application/pdf" ? "📕" : "📄";
        const sizeStr = f.size < 1024 ? `${f.size} B` : f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / 1024 / 1024).toFixed(1)} MB`;
        msg += `${icon} <b>${escapeHtml(f.filename)}</b> (${sizeStr})\n   ${escapeHtml(f.source || "unknown")} | ${hoursLeft}h left\n\n`;
      }
    }

    const kb = new InlineKeyboard();
    for (const f of files) {
      const isImage = f.contentType.startsWith("image/");
      const isAudio = f.contentType.startsWith("audio/");
      if (isImage) {
        kb.text(`View ${f.filename.slice(0, 12)}`, `file_view_${f.id}`).text("Del", `file_del_${f.id}`).row();
      } else if (isAudio) {
        kb.text(`Play ${f.filename.slice(0, 12)}`, `file_play_${f.id}`).text("Del", `file_del_${f.id}`).row();
      } else {
        kb.text(`View ${f.filename.slice(0, 12)}`, `file_view_${f.id}`).text("DL", `file_dl_${f.id}`).text("Del", `file_del_${f.id}`).row();
      }
    }
    if (page > 0 || files.length === limit) {
      if (page > 0) kb.text("« Prev", `btn_files_${page - 1}`);
      if (files.length === limit) kb.text("Next »", `btn_files_${page + 1}`);
      kb.row();
    }
    if (total > 0) kb.text("Delete All", "files_delete_all").row();
    kb.text("« Back", "btn_main");
    await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: kb });
  }

  bot.callbackQuery(/^btn_files(?:_(\d+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderFilesList(ctx, ctx.from!.id, parseInt(ctx.match?.[1] || "0"));
  });

  bot.callbackQuery(/^file_view_([a-f0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const fileId = ctx.match![1];
    const uid = ctx.from!.id;
    const file = fileStore.getFile(fileId);
    if (!file || file.uid !== uid) {
      await ctx.editMessageText("File not found or expired.", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Back", "btn_files") });
      return;
    }
    const buffer = fileStore.getFileBuffer(fileId);
    if (!buffer) {
      await ctx.editMessageText("File data not found.", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Back", "btn_files") });
      return;
    }
    const chatId = ctx.chat!.id;
    try {
      if (file.contentType.startsWith("image/")) {
        await bot.api.sendPhoto(chatId, new InputFile(buffer, file.filename));
      } else if (file.contentType.startsWith("audio/")) {
        await bot.api.sendAudio(chatId, new InputFile(buffer, file.filename));
      } else {
        const text = buffer.toString("utf8");
        if (text.length <= 4000) {
          await ctx.reply(`<b>${escapeHtml(file.filename)}</b>\n\n<pre>${escapeHtml(text)}</pre>`, { parse_mode: "HTML" });
        } else {
          await bot.api.sendDocument(chatId, new InputFile(buffer, file.filename));
        }
      }
    } catch (err: any) {
      await safeReply(ctx, `Failed to send file: ${escapeHtml(err.message?.slice(0, 100) || "unknown")}`);
    }
  });

  bot.callbackQuery(/^file_play_([a-f0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const file = fileStore.getFile(ctx.match![1]);
    if (!file || file.uid !== uid) return;
    const buffer = fileStore.getFileBuffer(ctx.match![1]);
    if (!buffer) return;
    try { await bot.api.sendAudio(ctx.chat!.id, new InputFile(buffer, file.filename)); } catch {}
  });

  bot.callbackQuery(/^file_dl_([a-f0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const file = fileStore.getFile(ctx.match![1]);
    if (!file || file.uid !== uid) return;
    const buffer = fileStore.getFileBuffer(ctx.match![1]);
    if (!buffer) return;
    try { await bot.api.sendDocument(ctx.chat!.id, new InputFile(buffer, file.filename)); } catch {}
  });

  bot.callbackQuery(/^file_del_([a-f0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Deleted");
    const uid = ctx.from!.id;
    const file = fileStore.getFile(ctx.match![1]);
    if (file && file.uid === uid) fileStore.deleteFile(ctx.match![1]);
    await renderFilesList(ctx, uid, 0);
  });

  bot.callbackQuery("files_delete_all", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>⚠️ Delete ALL your stored files?</b>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Yes, delete all", "files_delete_all_confirm").text("Cancel", "btn_files") },
    );
  });

  bot.callbackQuery("files_delete_all_confirm", async (ctx) => {
    await ctx.answerCallbackQuery("All files deleted");
    const uid = ctx.from!.id;
    const count = fileStore.deleteAllFiles(uid);
    await ctx.editMessageText(
      `<b>Deleted ${count} files.</b>`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  // ══════════════════════════════════════
  // ══ LISTEN MODE CALLBACKS ════════════
  // ══════════════════════════════════════

  bot.callbackQuery("btn_listen", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    if (!state.listenMode) { state.listenMode = true; startListening(uid); }
    state.currentMenu = "listening";
    await ctx.editMessageText(
      `<b>👂 Listen Mode ACTIVE</b>\n\nPolling every ${state.pollInterval / 1000}s\nFilter: ${state.listenFilter || "all services"}\n\n${state.lastPollCount} intents tracked`,
      { parse_mode: "HTML", reply_markup: listenKb(0) },
    );
  });

  bot.callbackQuery("btn_stop_listen", async (ctx) => {
    await ctx.answerCallbackQuery("Stopped");
    stopListening(ctx.from!.id);
    await ctx.editMessageText(`<b>👂 Listen Mode OFF</b>`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
  });

  bot.callbackQuery("btn_show_new", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const userAgent = await getUserAgent(ctx.from!.id);
      const result = (await userAgent.runAction("discover_intents", {})) as any;
      const list = (result?.intents || []).slice(0, 5);
      let msg = `<b>📬 Recent Intents</b>\n\n`;
      for (const i of list) {
        const svc = i.serviceName || i.service || "?";
        msg += `<b>#${i.intentIndex} ${escapeHtml(svc)}</b>\n├ 💰 ${i.budget ? formatTon(i.budget) : "?"} TON\n└ 👤 <code>${escapeHtml(shortAddr(i.buyer || ""))}</code>\n\n`;
      }
      await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: browseIntentsKb(list, 0) });
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  bot.callbackQuery("btn_listen_random", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const userAgent = await getUserAgent(ctx.from!.id);
      const result = (await userAgent.runAction("discover_intents", {})) as any;
      const all = result?.intents || [];
      // Shuffle and take 5
      const shuffled = all.sort(() => Math.random() - 0.5).slice(0, 5);
      let msg = `<b>🎲 Random Intents</b>\n\n`;
      for (const i of shuffled) {
        const svc = i.serviceName || i.service || "?";
        msg += `<b>#${i.intentIndex} ${escapeHtml(svc)}</b>\n├ 💰 ${i.budget ? formatTon(i.budget) : "?"} TON\n└ 👤 <code>${escapeHtml(shortAddr(i.buyer || ""))}</code>\n\n`;
      }
      await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: browseIntentsKb(shuffled, 0) });
    } catch (err: any) {
      await ctx.editMessageText(`⚠️ ${escapeHtml(err.message.slice(0, 200))}`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
    }
  });

  bot.callbackQuery("btn_listen_filter", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = getState(ctx.from!.id);
    state.awaitingInput = "listen_filter";
    await ctx.editMessageText(
      `<b>🔍 Listen Filter</b>\n\nCurrent: <b>${state.listenFilter || "all"}</b>\n\nType a service name to filter:\n<i>"price_feed"</i>, <i>"analytics"</i>, or <i>"all"</i> to clear`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Clear Filter", "btn_clear_filter").text("« Back", "btn_listen") },
    );
  });

  bot.callbackQuery("btn_clear_filter", async (ctx) => {
    await ctx.answerCallbackQuery("Filter cleared");
    const uid = ctx.from!.id;
    const state = getState(uid);
    state.listenFilter = undefined;
    state.awaitingInput = undefined;
    if (state.listenMode) { stopListening(uid); startListening(uid); }
    await ctx.editMessageText(
      `<b>👂 Listen Mode</b>\n\nFilter: <b>all services</b>\n${state.lastPollCount} intents tracked`,
      { parse_mode: "HTML", reply_markup: listenKb(0) },
    );
  });

  bot.callbackQuery("btn_poll_now", async (ctx) => {
    await ctx.answerCallbackQuery("Polling...");
    await pollIntents(ctx.from!.id);
  });

  // ══════════════════════════════════════
  // ══ AUTO MODE CALLBACKS ══════════════
  // ══════════════════════════════════════

  bot.callbackQuery("btn_auto", async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const state = getState(uid);
    if (!state.autoMode) state.autoMode = true;
    state.currentMenu = "auto";
    await ctx.editMessageText(
      `<b>🤖 Auto Mode ACTIVE</b>\n\nSend me a mission. I'll handle everything.\n\n<i>"Find a cheap price feed and buy it"</i>\n<i>"Register as analytics provider"</i>\n<i>"Check all intents and offer on the best ones"</i>`,
      { parse_mode: "HTML", reply_markup: autoModeKb(state) },
    );
  });

  bot.callbackQuery("btn_stop_auto", async (ctx) => {
    await ctx.answerCallbackQuery("Stopped");
    const state = getState(ctx.from!.id);
    state.autoMode = false;
    state.autoRunning = false;
    await ctx.editMessageText(`<b>🤖 Auto Mode OFF</b>`, { parse_mode: "HTML", reply_markup: mainMenuKb() });
  });

  // ══════════════════════════════════════
  // ══ MESSAGE HANDLER ══════════════════
  // ══════════════════════════════════════

  bot.on("message:text", async (ctx) => {
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
        secretStore.saveWallet(uid, mnemonic, addr);
        state.walletReady = true;
        userAgents.delete(uid);
        chatHistories.delete(ctx.chat!.id);
        const kb = new InlineKeyboard();
        if (!secretStore.hasApiKey(uid)) kb.text("🧠 Set up AI key", "setup_ai_provider").row();
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
        secretStore.saveApiKey(uid, providerKey, modelId, apiKey);
        delete (state as any)._tempApiKey;
        state.pendingProvider = undefined;
        state.aiReady = true;
        userOpenAIClients.delete(uid);
        chatHistories.delete(ctx.chat!.id);
        const kb = new InlineKeyboard();
        if (!secretStore.hasWallet(uid)) kb.text("🔑 Set up wallet", "setup_wallet_generate").row();
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
    if (userLocks.get(uid)) {
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
      if (state.listenMode) { stopListening(uid); startListening(uid); }
      await safeReply(ctx, `Filter set to: <b>${state.listenFilter || "all"}</b>`, { reply_markup: listenKb(0) });
      return;
    }

    // Awaiting input for transfer/swap/new_intent → route to LLM with context
    if (state.awaitingInput) {
      const prefix = state.awaitingInput === "new_intent" ? "I want to broadcast an intent for: "
        : state.awaitingInput === "transfer" ? "I want to transfer: "
        : "I want to swap: ";
      state.awaitingInput = undefined;
      return handleNormalMessage(ctx, prefix + text);
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
      return handleAutoMode(ctx, state, text);
    }

    // Normal LLM handler
    return handleNormalMessage(ctx, text);
  });

  // ── Bot setup ──
  bot.catch((err: any) => console.error("Bot error:", err.message?.slice(0, 100)));

  await bot.api.setMyCommands([
    { command: "start", description: "Open main menu" },
  ]);

  const { run } = await import("@grammyjs/runner");
  const runner = run(bot);

  // Cleanup expired files every hour
  const fileCleanupTimer = setInterval(() => {
    try {
      const count = fileStore.cleanupExpired();
      if (count > 0) console.log(`  Cleaned up ${count} expired files`);
    } catch {}
  }, 3600000);

  console.log(`\n${"━".repeat(40)}`);
  console.log(`  🤖 TON Agent Kit Bot (Multi-User)`);
  console.log(`  📍 Dev: ${shortAddr(devFriendlyAddr)}`);
  console.log(`  🌐 ${NETWORK} | x402: ${publicUrl}`);
  console.log(`  ⚡ ${readOnlyAgent.getAvailableActions().length} actions`);
  console.log(`  🧠 Users bring their own AI key`);
  console.log(`  💰 Users bring their own wallet`);
  console.log(`${"━".repeat(40)}\n`);

  process.on("SIGINT", () => {
    clearInterval(fileCleanupTimer);
    for (const [, s] of userStates) {
      if (s.listenTimer) clearInterval(s.listenTimer);
      if (s.offerTrackTimer) clearInterval(s.offerTrackTimer);
    }
    x402Server.close();
    runner.stop();
  });
  process.on("SIGTERM", () => {
    clearInterval(fileCleanupTimer);
    for (const [, s] of userStates) {
      if (s.listenTimer) clearInterval(s.listenTimer);
      if (s.offerTrackTimer) clearInterval(s.offerTrackTimer);
    }
    x402Server.close();
    runner.stop();
  });
}

main().catch(console.error);
