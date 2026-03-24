import { readFileSync } from "fs";

let envContent = "";
try {
  envContent = readFileSync(".env", "utf-8");
} catch {
  // No .env file — rely on process.env
}
export const getEnv = (key: string) =>
  envContent
    .split("\n")
    .find((l) => l.startsWith(key + "="))
    ?.slice(key.length + 1)
    .trim() || "";

// Only override process.env when .env has a value (preserves Docker/CI env vars)
for (const k of ["TON_MNEMONIC", "TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "OPENAI_BASE_URL", "AI_MODEL", "TON_NETWORK", "TON_RPC_URL", "TONAPI_KEY"]) {
  const v = getEnv(k);
  if (v) process.env[k] = v;
}

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
export const MNEMONIC = process.env.TON_MNEMONIC || "";
export const NETWORK = (process.env.TON_NETWORK as "testnet" | "mainnet") || "testnet";
export const RPC_URL = process.env.TON_RPC_URL || "https://testnet-v4.tonhubapi.com";
export const X402_PORT = parseInt(getEnv("X402_PORT") || "4000", 10);
export const AUTO_APPROVE_LIMIT = 0.05;

// ── HITL action sets ──
export const HITL_ACTIONS = new Set([
  "transfer_ton", "transfer_jetton", "create_escrow",
  "deposit_to_escrow", "release_escrow", "refund_escrow",
  "open_dispute", "accept_offer", "stake_ton", "unstake_ton",
  "swap_dedust", "swap_stonfi", "swap_best_price",
  "broadcast_intent", "join_dispute", "seller_stake_escrow",
  "settle_deal", "confirm_delivery", "send_offer",
  "vote_release", "vote_refund", "claim_reward", "cancel_intent",
  "register_agent", "deploy_jetton",
  "pay_for_resource",          // sends TON via x402 — amount from 402 response
]);
export const ALWAYS_CONFIRM = new Set([
  "vote_release", "vote_refund", "confirm_delivery",
  "settle_deal", "send_offer", "cancel_intent",
  "open_dispute", "join_dispute",
  "register_agent",          // no amount field
  "broadcast_intent",        // budget is a string, not amount
  "accept_offer",            // engages a deal, no amount
  "deploy_jetton",           // deploys a contract
  "create_escrow",           // deploys an escrow contract
  "deposit_to_escrow",       // amount in custom field
  "seller_stake_escrow",     // stake, not amount
  "pay_for_resource",        // amount determined by 402 response, not in LLM params
]);

export const READ_ONLY_ACTIONS = new Set([
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

export function needsApproval(action: string, params: any, mode: string): boolean {
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

// ── UserState ──
export interface UserState {
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

export const userStates = new Map<number, UserState>();

export function getState(uid: number): UserState {
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
