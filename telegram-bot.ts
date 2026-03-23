import { TonClient4 } from "@ton/ton";
import { mnemonicNew } from "@ton/crypto";
import { Bot } from "grammy";
import OpenAI from "openai";
import { TonAgentKit, KeypairWallet } from "@ton-agent-kit/core";
import { SecretStore, ensureServerSecret, FileStore } from "@ton-agent-kit/wallet-store";
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

import { BOT_TOKEN, MNEMONIC, NETWORK, RPC_URL, X402_PORT, userStates } from "./src/config";
import { shortAddr } from "./src/helpers";
import type { BotContext } from "./src/context";
import { setupX402Server } from "./src/services/x402";
import { registerHitlHandlers } from "./src/handlers/hitl";
import { registerOnboardingHandlers } from "./src/handlers/onboarding";
import { registerMainMenuHandlers } from "./src/handlers/main-menu";
import { registerSettingsHandlers } from "./src/handlers/settings";
import { registerListenHandlers } from "./src/handlers/listen-mode";
import { registerAutoHandlers } from "./src/handlers/auto-mode";
import { registerFilesHandlers } from "./src/handlers/files";
import { registerMessageHandler } from "./src/handlers/message";

async function main() {
  // Step 1: Network mode
  const publicUrl = await selectNetworkMode(X402_PORT);
  console.log(`  Network: ${publicUrl}\n`);

  // Step 2: Secret store
  const serverSecret = ensureServerSecret();
  const secretStore = new SecretStore("data/wallets.db", serverSecret);
  const fileStore = new FileStore(secretStore.getDb(), "data/files");

  // Step 3: Endpoint plugin (factory — uses publicUrl + shared routes map)
  const endpointRoutes = new Map<string, EndpointConfig>();
  const EndpointPlugin = createEndpointPlugin({
    port: X402_PORT,
    getPublicUrl: () => publicUrl,
    routes: endpointRoutes,
  });

  // Step 4: Bot + Agent setup
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

  // Build context
  const botCtx: BotContext = {
    bot,
    secretStore,
    fileStore,
    readOnlyAgent,
    chatHistories: new Map<number, OpenAI.ChatCompletionMessageParam[]>(),
    userAgents: new Map(),
    userOpenAIClients: new Map(),
    pendingApprovals: new Map(),
    endpointRoutes,
    userLocks: new Map(),
    publicUrl,
    viewerBase,
    devAddress,
    devFriendlyAddr,
    network: NETWORK,
    x402Port: X402_PORT,
  };

  // x402 server
  const x402Server = setupX402Server(botCtx);

  // Register all handlers (order matters — message handler MUST be last)
  registerHitlHandlers(botCtx);
  registerOnboardingHandlers(botCtx);
  registerMainMenuHandlers(botCtx);
  registerSettingsHandlers(botCtx);
  registerListenHandlers(botCtx);
  registerAutoHandlers(botCtx);
  registerFilesHandlers(botCtx);
  registerMessageHandler(botCtx);  // MUST be last (catches all text)

  // Bot setup
  bot.catch((err: any) => console.error("Bot error:", err.message?.slice(0, 100)));
  await bot.api.setMyCommands([{ command: "start", description: "Open main menu" }]);

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

  const cleanup = () => {
    clearInterval(fileCleanupTimer);
    for (const [, s] of userStates) {
      if (s.listenTimer) clearInterval(s.listenTimer);
      if (s.offerTrackTimer) clearInterval(s.offerTrackTimer);
    }
    x402Server.close();
    runner.stop();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch(console.error);
