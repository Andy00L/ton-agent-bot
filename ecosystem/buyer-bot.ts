// ecosystem/buyer-bot.ts
// Buyer bot — creates intents, accepts offers, pays x402, confirms delivery
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
// CONFIG — Leave mnemonic empty to auto-generate
// ══════════════════════════════════════
const MNEMONIC =
  "certain trap dentist thought leg female jeans note cheese story bargain occur cancel shock trip wise pitch census truck congress ordinary release advice coil";
const NETWORK: "testnet" | "mainnet" = "testnet";
const RPC_URL = "https://testnet-v4.tonhubapi.com";
const AGENT_NAME = "buyer-bot";
const BUDGET = "0.2";
const ROUND_INTERVAL = 60_000;

// Services to cycle through
const SERVICES = [
  { service: "image_delivery", description: "Need a sample image for testing" },
  { service: "audio_delivery", description: "Need a sample audio clip" },
  { service: "gif_delivery", description: "Need an animated GIF" },
];

// ══════════════════════════════════════
// MAIN
// ══════════════════════════════════════
async function main() {
  log("BUYER", "INIT", "Starting buyer bot...");

  // Wallet
  let words: string[];
  if (MNEMONIC && MNEMONIC.split(" ").length === 24) {
    words = MNEMONIC.split(" ");
  } else {
    words = await mnemonicNew(24);
    log("BUYER", "MNEMONIC", `Generated: ${words.join(" ")}`);
    log(
      "BUYER",
      "MNEMONIC",
      "Fund this wallet on https://t.me/testgiver_ton_bot",
    );
  }
  const wallet = await KeypairWallet.fromMnemonic(words, {
    network: NETWORK,
    version: "V5R1",
  });
  const myAddr = toFriendlyAddress(wallet.address, NETWORK === "testnet");
  log("BUYER", "WALLET", `Address: ${myAddr}`);

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

  // Register
  try {
    await agent.runAction("register_agent", {
      name: AGENT_NAME,
      description: "Automated buyer — requests media content",
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

  let serviceIdx = 0;

  // ══ Main loop ══
  while (true) {
    const svc = SERVICES[serviceIdx % SERVICES.length];
    serviceIdx++;
    const round = serviceIdx;

    log("BUYER", "ROUND", `${"═".repeat(40)}`);
    log("BUYER", "ROUND", `Round ${round}: ${svc.service}`);
    log("BUYER", "ROUND", `${"═".repeat(40)}`);

    // Step 1: Broadcast intent
    let intentIndex: number | null = null;
    try {
      log(
        "BUYER",
        "INTENT",
        `Broadcasting: ${svc.service} (budget: ${BUDGET} TON)...`,
      );
      const intent = (await agent.runAction("broadcast_intent", {
        service: svc.service,
        budget: BUDGET,
        deadlineMinutes: 60,
        description: svc.description,
      })) as any;
      intentIndex = intent?.intentIndex ?? null;
      if (intentIndex !== null) {
        logSuccess("BUYER", "INTENT", `Intent #${intentIndex} broadcast`);
      } else {
        logError(
          "BUYER",
          "INTENT",
          `No intentIndex in response: ${JSON.stringify(intent)}`,
        );
        await sleep(ROUND_INTERVAL);
        continue;
      }
    } catch (err: any) {
      logError("BUYER", "INTENT", err.message);
      await sleep(ROUND_INTERVAL);
      continue;
    }

    // Step 2: Wait for offers
    log("BUYER", "WAIT", "Waiting 45s for offers...");
    await sleep(45_000);

    // Step 3: Get offers
    let bestOffer: any = null;
    let priceInTon: string | null = null;
    try {
      log("BUYER", "OFFERS", `Checking offers on intent #${intentIndex}...`);
      const offers = (await agent.runAction("get_offers", {
        intentIndex,
      })) as any;
      const list = offers?.offers || [];
      log("BUYER", "OFFERS", `Found ${list.length} offers`);

      if (list.length === 0) {
        log("BUYER", "OFFERS", "No offers received. Skipping round.");
        await sleep(ROUND_INTERVAL);
        continue;
      }

      // Pick cheapest offer
      bestOffer = list.reduce((best: any, o: any) => {
        const price = parseFloat(o.price || "999");
        return price < parseFloat(best?.price || "999") ? o : best;
      }, list[0]);

      priceInTon = parseFloat(bestOffer.price) > 1000
        ? (parseFloat(bestOffer.price) / 1e9).toString()
        : bestOffer.price;

      logSuccess(
        "BUYER",
        "OFFERS",
        `Best: #${bestOffer.offerIndex} at ${priceInTon} TON from ${(bestOffer.seller || "?").slice(0, 20)}...`,
      );
    } catch (err: any) {
      logError("BUYER", "OFFERS", err.message);
      await sleep(ROUND_INTERVAL);
      continue;
    }

    if (!priceInTon) {
      logError("BUYER", "ESCROW", "priceInTon not set, skipping");
      await sleep(ROUND_INTERVAL);
      continue;
    }

    // Validate seller address before proceeding
    if (!bestOffer.seller) {
      logError("BUYER", "ESCROW", "Offer has no seller address, skipping");
      await sleep(ROUND_INTERVAL);
      continue;
    }

    // Step 4: Accept offer
    try {
      log("BUYER", "ACCEPT", `Accepting offer #${bestOffer.offerIndex}...`);
      await agent.runAction("accept_offer", {
        offerIndex: bestOffer.offerIndex,
      });
      logSuccess("BUYER", "ACCEPT", `Offer #${bestOffer.offerIndex} accepted`);
    } catch (err: any) {
      logError("BUYER", "ACCEPT", err.message);
      await sleep(ROUND_INTERVAL);
      continue;
    }

    // Step 5: Create escrow + deposit
    let escrowId: string | null = null;
    try {
      log(
        "BUYER",
        "ESCROW",
        `Creating escrow (beneficiary: ${(bestOffer.seller || "?").slice(0, 20)}..., amount: ${priceInTon} TON)...`,
      );
      const escrow = (await agent.runAction("create_escrow", {
        beneficiary: bestOffer.seller,
        amount: priceInTon,
        minArbiters: 3,
        description: `Payment for ${svc.service} (intent #${intentIndex})`,
        deadlineMinutes: 60,
      })) as any;
      escrowId = escrow?.escrowId || escrow?.escrowAddress || null;
      if (!escrowId) {
        logError(
          "BUYER",
          "ESCROW",
          `No escrowId in response: ${JSON.stringify(escrow)}`,
        );
        await sleep(ROUND_INTERVAL);
        continue;
      }
      logSuccess("BUYER", "ESCROW", `Created: ${escrowId}`);

      log("BUYER", "DEPOSIT", `Depositing to escrow ${escrowId}...`);
      await agent.runAction("deposit_to_escrow", { escrowId });
      logSuccess("BUYER", "DEPOSIT", "Deposited");

      // Verify escrow is funded before paying
      const escrowInfo = await agent.runAction("get_escrow_info", { escrowId }) as any;
      if (!escrowInfo?.deposited && !escrowInfo?.amount) {
        logError("BUYER", "DEPOSIT", "Escrow not funded after deposit, skipping round");
        await sleep(ROUND_INTERVAL);
        continue;
      }
    } catch (err: any) {
      logError("BUYER", "ESCROW", err.message);
      await sleep(ROUND_INTERVAL);
      continue;
    }

    // Step 6: Pay via x402 (if endpoint provided)
    const endpoint = bestOffer.endpoint;
    if (endpoint && endpoint !== "pending") {
      try {
        log("BUYER", "PAY", `Paying x402: ${endpoint}...`);
        const payment = (await agent.runAction("pay_for_resource", {
          url: endpoint,
          escrowId,
        })) as any;
        logSuccess(
          "BUYER",
          "PAY",
          `Paid! txHash: ${payment?.txHash || "?"}, proof: ${(payment?.deliveryProof?.responseHash || "?").slice(0, 16)}...`,
        );

        // Step 7: Confirm delivery (may be auto-done by pay_for_resource with escrowId)
        await sleep(5000);
        try {
          log("BUYER", "CONFIRM", "Confirming delivery...");
          await agent.runAction("confirm_delivery", {
            escrowId,
            x402TxHash: payment?.txHash,
          });
          logSuccess("BUYER", "CONFIRM", "Delivery confirmed on-chain");
        } catch (err: any) {
          // May already be confirmed by pay_for_resource
          log(
            "BUYER",
            "CONFIRM",
            `Skipped or already done: ${err.message?.slice(0, 80)}`,
          );
        }

        // Step 8: Release escrow
        await sleep(5000);
        try {
          log("BUYER", "RELEASE", "Releasing escrow...");
          await agent.runAction("release_escrow", { escrowId });
          logSuccess("BUYER", "RELEASE", "Escrow released to seller");
        } catch (err: any) {
          logError("BUYER", "RELEASE", err.message?.slice(0, 100));
        }

        // Step 9: Settle deal + rate
        await sleep(5000);
        try {
          log("BUYER", "SETTLE", `Settling deal on intent #${intentIndex}...`);
          await agent.runAction("settle_deal", {
            intentIndex,
            rating: 85,
          });
          logSuccess("BUYER", "SETTLE", "Deal settled with rating 85/100");
        } catch (err: any) {
          logError("BUYER", "SETTLE", err.message?.slice(0, 100));
        }
      } catch (err: any) {
        logError("BUYER", "PAY", err.message);
      }
    } else {
      log("BUYER", "PAY", "No endpoint in offer. Waiting for manual delivery.");
    }

    log("BUYER", "ROUND", `Round ${round} complete`);
    log("BUYER", "WAIT", `Next round in ${ROUND_INTERVAL / 1000}s...`);
    await sleep(ROUND_INTERVAL);
  }
}

main().catch((err) => {
  logError("BUYER", "FATAL", err.message);
  process.exit(1);
});
