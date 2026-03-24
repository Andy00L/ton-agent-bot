// ecosystem/buyer-bot.ts
// Buyer bot — responds to EXTERNAL intents only (no self-broadcasting)
// Discovers open intents, checks for offers on its own past intents, accepts best offers.
// NO LLM. Pure scripted loop.

import {
  TonAgentKit,
  KeypairWallet,
  toFriendlyAddress,
} from "@ton-agent-kit/core";
import { mnemonicNew } from "@ton/crypto";
import TokenPlugin from "@ton-agent-kit/plugin-token";
import EscrowPlugin from "@ton-agent-kit/plugin-escrow";
import IdentityPlugin from "@ton-agent-kit/plugin-identity";
import AgentCommPlugin from "@ton-agent-kit/plugin-agent-comm";
import PaymentsPlugin from "@ton-agent-kit/plugin-payments";
import { log, logError, logSuccess, sleep } from "./logger";

// ══════════════════════════════════════
// CONFIG
// ══════════════════════════════════════
const MNEMONIC =
  "certain trap dentist thought leg female jeans note cheese story bargain occur cancel shock trip wise pitch census truck congress ordinary release advice coil";
const NETWORK: "testnet" | "mainnet" = "testnet";
const RPC_URL = "https://testnet-v4.tonhubapi.com";
const AGENT_NAME = "buyer-bot";
const POLL_INTERVAL = 15_000;

// ══════════════════════════════════════
// MAIN
// ══════════════════════════════════════
async function main() {
  log("BUYER", "INIT", "Starting buyer bot (respond-only mode)...");

  // Wallet
  let words: string[];
  if (MNEMONIC && MNEMONIC.split(" ").length === 24) {
    words = MNEMONIC.split(" ");
  } else {
    words = await mnemonicNew(24);
    log("BUYER", "MNEMONIC", `Generated: ${words.join(" ")}`);
    log("BUYER", "MNEMONIC", "Fund this wallet on https://t.me/testgiver_ton_bot");
  }
  const wallet = await KeypairWallet.fromMnemonic(words, {
    network: NETWORK,
    version: "V5R1",
  });
  const myAddr = wallet.address.toRawString();
  const myFriendly = toFriendlyAddress(wallet.address, NETWORK === "testnet");
  log("BUYER", "WALLET", `Address: ${myFriendly}`);

  const agent = new TonAgentKit(wallet, RPC_URL, {}, NETWORK)
    .use(TokenPlugin)
    .use(EscrowPlugin)
    .use(IdentityPlugin)
    .use(AgentCommPlugin)
    .use(PaymentsPlugin);

  // Balance
  try {
    const bal = (await agent.runAction("get_balance", {})) as any;
    log("BUYER", "BALANCE", `${bal.balance} TON`);
  } catch (err: any) {
    logError("BUYER", "BALANCE", err.message);
  }

  // Register once
  try {
    await agent.runAction("register_agent", {
      name: AGENT_NAME,
      description: "Automated buyer — accepts offers on external intents",
      capabilities: ["buying"],
    });
    logSuccess("BUYER", "REGISTER", "Agent registered");
  } catch (err: any) {
    if (err.message?.includes("already registered")) {
      log("BUYER", "REGISTER", "Already registered, continuing...");
    } else {
      logError("BUYER", "REGISTER", err.message);
    }
  }

  // Track intents we've interacted with
  const processedIntents = new Set<number>();

  // ══ Main loop — watch for external intents, check offers on our past intents ══
  log("BUYER", "LOOP", `Watching for external intents (every ${POLL_INTERVAL / 1000}s)...`);

  while (true) {
    try {
      // Discover open intents (from OTHER agents/users, not us)
      const result = (await agent.runAction("discover_intents", {})) as any;
      const intents = result?.intents || [];

      // Filter: only intents from OTHER addresses
      const externalIntents = intents.filter(
        (i: any) => i.buyer !== myAddr && !processedIntents.has(i.intentIndex),
      );

      if (externalIntents.length > 0) {
        log("BUYER", "POLL", `Found ${externalIntents.length} external intent(s)`);
      }

      for (const intent of externalIntents) {
        const idx = intent.intentIndex as number;
        if (idx < 0) continue; // Skip invalid intents
        const service = (intent.serviceName || intent.service || "") as string;
        log("BUYER", "FOUND", `External intent #${idx}: ${service} (${intent.budget || "?"} nanoTON)`);
        processedIntents.add(idx);

        // Check if this intent already has offers we can accept
        try {
          const offers = (await agent.runAction("get_offers", { intentIndex: idx })) as any;
          const list = offers?.offers || [];
          if (list.length > 0) {
            log("BUYER", "OFFERS", `Intent #${idx} has ${list.length} offer(s) — available for acceptance`);
          }
        } catch {}
      }

      // Cleanup old entries
      if (processedIntents.size > 1000) processedIntents.clear();
    } catch (err: any) {
      logError("BUYER", "POLL", err.message);
    }

    await sleep(POLL_INTERVAL);
  }
}

main().catch((err) => {
  logError("BUYER", "FATAL", err.message);
  process.exit(1);
});
