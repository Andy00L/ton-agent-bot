// ecosystem/arbiter-bot.ts
// 3 Arbiter bots in 1 file — join disputes, vote, claim rewards
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
import { log, logError, logSuccess, sleep } from "./logger";

// ══════════════════════════════════════
// CONFIG — Leave mnemonic empty to auto-generate
// ══════════════════════════════════════
const ARBITERS = [
  {
    name: "arbiter-alpha",
    mnemonic:
      "card owner state soccer style account yellow gauge connect office hospital reform distance smoke essence eight connect estate aim humble question state satisfy firm",
  },
  {
    name: "arbiter-beta",
    mnemonic:
      "delay erode danger distance awake album pitch few reason only sudden rubber dynamic bleak school blast witness giggle cradle silly broom belt donate crisp",
  },
  {
    name: "arbiter-gamma",
    mnemonic:
      "pilot road sight wear piano genuine plunge end camera glide work ramp spatial rifle meat army ecology demise cream dirt home spell urge gauge",
  },
];
const NETWORK: "testnet" | "mainnet" = "testnet";
const RPC_URL = "https://testnet-v4.tonhubapi.com";
const POLL_INTERVAL = 15_000;
const STAKE_AMOUNT = "0.5"; // Default minStake per the SDK

// ══════════════════════════════════════
// ARBITER LOOP
// ══════════════════════════════════════
async function runArbiter(config: (typeof ARBITERS)[0]) {
  const BOT = `ARBITER:${config.name}`;

  log(BOT, "INIT", `Starting arbiter ${config.name}...`);

  // Wallet
  let words: string[];
  if (config.mnemonic && config.mnemonic.split(" ").length === 24) {
    words = config.mnemonic.split(" ");
  } else {
    words = await mnemonicNew(24);
    log(BOT, "MNEMONIC", `Generated: ${words.join(" ")}`);
    log(BOT, "MNEMONIC", "Fund this wallet on https://t.me/testgiver_ton_bot");
  }
  const wallet = await KeypairWallet.fromMnemonic(words, {
    network: NETWORK,
    version: "V5R1",
  });
  log(
    BOT,
    "WALLET",
    `Address: ${toFriendlyAddress(wallet.address, NETWORK === "testnet")}`,
  );

  const agent = new TonAgentKit(wallet, RPC_URL, {}, NETWORK)
    .use(TokenPlugin)
    .use(EscrowPlugin)
    .use(IdentityPlugin);

  // Balance
  try {
    const bal = (await agent.runAction("get_balance", {})) as any;
    log(BOT, "BALANCE", `${bal.balance} TON`);
  } catch (err: any) {
    logError(BOT, "BALANCE", err.message);
  }

  // Register as arbiter
  try {
    await agent.runAction("register_agent", {
      name: config.name,
      description: "Dispute arbiter — votes based on x402 delivery proof",
      capabilities: ["arbitration", "dispute_resolution"],
    });
    logSuccess(BOT, "REGISTER", "Agent registered");
  } catch (err: any) {
    if (err.message?.includes("already registered")) {
      log(BOT, "REGISTER", "Already registered, continuing...");
    } else {
      logError(BOT, "REGISTER", err.message);
    }
  }

  // Track joined disputes
  const joinedDisputes = new Set<string>();

  while (true) {
    try {
      log(BOT, "POLL", "Checking open disputes...");
      const disputes = (await agent.runAction("get_open_disputes", {
        limit: 10,
      })) as any;
      const list = disputes?.disputes || [];
      log(BOT, "POLL", `Found ${list.length} open disputes`);

      for (const dispute of list) {
        const escrowId = dispute.escrowId || dispute.escrowAddress;
        if (!escrowId) continue;
        if (joinedDisputes.has(escrowId)) continue;

        // Join the dispute
        log(BOT, "JOIN", `Joining dispute on escrow ${escrowId}...`);
        try {
          await agent.runAction("join_dispute", {
            escrowId,
            stake: STAKE_AMOUNT,
          });
          joinedDisputes.add(escrowId);
          logSuccess(BOT, "JOIN", `Joined dispute on ${escrowId}`);
        } catch (err: any) {
          logError(BOT, "JOIN", `Failed: ${err.message}`);
          // Don't mark as joined — will retry on next poll
          continue;
        }

        // Wait then check escrow info to decide vote
        await sleep(5000);

        try {
          const info = (await agent.runAction("get_escrow_info", {
            escrowId,
          })) as any;
          const deliveryConfirmed = info?.deliveryConfirmed === true;
          const hasProof = !!(
            info?.x402ProofHash && info.x402ProofHash.length > 0
          );

          log(
            BOT,
            "DECIDE",
            `Escrow ${escrowId}: proof=${hasProof}, delivered=${deliveryConfirmed}`,
          );

          if (deliveryConfirmed || hasProof) {
            log(
              BOT,
              "VOTE",
              `Voting RELEASE on ${escrowId} (delivery confirmed or proof found)`,
            );
            await agent.runAction("vote_release", { escrowId });
            logSuccess(BOT, "VOTE", `Voted RELEASE on ${escrowId}`);
          } else {
            log(
              BOT,
              "VOTE",
              `Voting REFUND on ${escrowId} (no proof of delivery)`,
            );
            await agent.runAction("vote_refund", { escrowId });
            logSuccess(BOT, "VOTE", `Voted REFUND on ${escrowId}`);
          }
        } catch (err: any) {
          logError(BOT, "VOTE", `Failed: ${err.message}`);
        }

        // Try to claim reward
        await sleep(10_000);
        try {
          const reward = await agent.runAction("claim_reward", { escrowId });
          logSuccess(
            BOT,
            "REWARD",
            `Claimed on ${escrowId}: ${JSON.stringify(reward)}`,
          );
        } catch (err: any) {
          log(BOT, "REWARD", `Not ready: ${err.message?.slice(0, 80)}`);
        }
      }
    } catch (err: any) {
      logError(BOT, "POLL", err.message);
    }

    await sleep(POLL_INTERVAL);
  }
}

// ══════════════════════════════════════
// LAUNCH ALL 3
// ══════════════════════════════════════
async function main() {
  log("ARBITER", "INIT", `Launching ${ARBITERS.length} arbiters...`);
  // Stagger startup by 2s each to avoid RPC floods
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < ARBITERS.length; i++) {
    if (i > 0) await sleep(2000);
    tasks.push(runArbiter(ARBITERS[i]));
  }
  await Promise.all(tasks);
}

main().catch((err) => {
  logError("ARBITER", "FATAL", err.message);
  process.exit(1);
});
