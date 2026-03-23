import OpenAI from "openai";
import { TonAgentKit, KeypairWallet } from "@ton-agent-kit/core";
import { LLM_PROVIDERS } from "@ton-agent-kit/wallet-store";
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
import type { BotContext } from "../context";
import { NETWORK, RPC_URL } from "../config";

// ── Per-user agent + OpenAI helpers ──
export async function getUserAgent(ctx: BotContext, uid: number): Promise<TonAgentKit> {
  if (ctx.userAgents.has(uid)) return ctx.userAgents.get(uid)!;
  const stored = ctx.secretStore.loadWallet(uid);
  if (!stored) return ctx.readOnlyAgent;
  const words = stored.mnemonic.split(" ");
  const wallet = await KeypairWallet.fromMnemonic(words, { network: NETWORK, version: "V5R1" });
  const userAgent = new TonAgentKit(wallet, RPC_URL, {}, NETWORK)
    .use(TokenPlugin).use(DefiPlugin).use(DnsPlugin).use(NftPlugin)
    .use(StakingPlugin).use(EscrowPlugin).use(IdentityPlugin)
    .use(AnalyticsPlugin).use(PaymentsPlugin).use(AgentCommPlugin);
  ctx.userAgents.set(uid, userAgent);
  return userAgent;
}

export function getUserOpenAI(ctx: BotContext, uid: number): { client: OpenAI; model: string } | null {
  if (ctx.userOpenAIClients.has(uid)) return ctx.userOpenAIClients.get(uid)!;
  const stored = ctx.secretStore.loadApiKey(uid);
  if (!stored) return null;
  const provider = LLM_PROVIDERS[stored.provider];
  const entry = {
    client: new OpenAI({
      apiKey: stored.apiKey,
      baseURL: provider?.baseURL,
    }),
    model: stored.model,
  };
  ctx.userOpenAIClients.set(uid, entry);
  return entry;
}

export function makeSystemPrompt(ctx: BotContext, uid: number, userAddr: string): string {
  const hasWallet = ctx.secretStore.hasWallet(uid);
  const walletLine = hasWallet
    ? `Wallet: ${userAddr} | Network: ${ctx.network} | Actions: ${ctx.readOnlyAgent.actionCount}`
    : `⚠️ This user has NO wallet configured. If they ask about their wallet, balance, or address, tell them to set one up in Settings → Wallet. Do NOT show any other address as theirs. | Network: ${ctx.network} | Actions: ${ctx.readOnlyAgent.actionCount}`;
  return `You are TON Agent Kit Bot — an AI agent on TON blockchain inside Telegram.
You run an x402 HTTP server at ${ctx.publicUrl} for paid data endpoints.

${walletLine}

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
Then: send_offer({ intentIndex: 3, price: "0.05", endpoint: "${ctx.publicUrl}/api/price" })

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
- After the address, add a Tonviewer link: ${ctx.viewerBase}/FULL_ADDRESS`;
}
