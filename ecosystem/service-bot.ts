// ecosystem/service-bot.ts
// Service Provider bot — serves images, audio, gif via x402
// NO LLM. Pure scripted loop.

import { TonAgentKit, KeypairWallet } from "@ton-agent-kit/core";
import { mnemonicNew } from "@ton/crypto";
import TokenPlugin from "@ton-agent-kit/plugin-token";
import EscrowPlugin from "@ton-agent-kit/plugin-escrow";
import IdentityPlugin from "@ton-agent-kit/plugin-identity";
import AgentCommPlugin from "@ton-agent-kit/plugin-agent-comm";
import PaymentsPlugin from "@ton-agent-kit/plugin-payments";
import { tonPaywall, MemoryReplayStore } from "@ton-agent-kit/x402-middleware";
import express from "express";
import { readFileSync } from "fs";
import { log, logError, logSuccess, sleep } from "./logger";

// ══════════════════════════════════════
// CONFIG
// ══════════════════════════════════════
const MNEMONIC = ""; // Leave empty to auto-generate. Paste 24 words to reuse.
const NETWORK: "testnet" | "mainnet" = "testnet";
const RPC_URL = "https://testnet-v4.tonhubapi.com";
const X402_PORT = 4001;
const PUBLIC_URL = process.env.SERVICE_URL || `http://localhost:${X402_PORT}`;
const AGENT_NAME = "media-service";
const CAPABILITIES = ["image_delivery", "audio_delivery", "gif_delivery"];
const POLL_INTERVAL = 30_000;
const OFFER_PRICE = "0.05";

// ══════════════════════════════════════
// MAIN
// ══════════════════════════════════════
async function main() {
  log("SERVICE", "INIT", "Starting service provider bot...");

  // Wallet
  let words: string[];
  if (MNEMONIC && MNEMONIC.split(" ").length === 24) {
    words = MNEMONIC.split(" ");
  } else {
    words = await mnemonicNew(24);
    log("SERVICE", "MNEMONIC", `Generated: ${words.join(" ")}`);
    log("SERVICE", "MNEMONIC", "Fund this wallet on https://t.me/testgiver_ton_bot");
  }
  const wallet = await KeypairWallet.fromMnemonic(words, { network: NETWORK, version: "V5R1" });
  const walletAddr = wallet.address.toString({ bounceable: false, testOnly: NETWORK === "testnet" });
  log("SERVICE", "WALLET", `Address: ${walletAddr}`);

  const agent = new TonAgentKit(wallet, RPC_URL, {}, NETWORK)
    .use(TokenPlugin)
    .use(EscrowPlugin)
    .use(IdentityPlugin)
    .use(AgentCommPlugin)
    .use(PaymentsPlugin);

  // Balance
  try {
    const bal = (await agent.runAction("get_balance", {})) as any;
    log("SERVICE", "BALANCE", `${bal.balance} TON`);
  } catch (err: any) {
    logError("SERVICE", "BALANCE", err.message);
  }

  // ══ x402 Express server ══
  const app = express();
  const replayStore = new MemoryReplayStore();

  // Load assets
  const loadAsset = (path: string, label: string): Buffer => {
    try {
      const buf = readFileSync(path);
      log("SERVICE", "ASSETS", `${label} loaded (${buf.length} bytes)`);
      return buf;
    } catch {
      log("SERVICE", "ASSETS", `${label} not found, using placeholder`);
      return Buffer.from(`placeholder-${label}`);
    }
  };
  const imageBuffer = loadAsset("ecosystem/assets/sample.png", "sample.png");
  const audioBuffer = loadAsset("ecosystem/assets/sample.mp3", "sample.mp3");
  const gifBuffer = loadAsset("ecosystem/assets/sample.gif", "sample.gif");

  // Paywall middleware
  const paywall = tonPaywall({
    amount: OFFER_PRICE,
    recipient: walletAddr,
    network: NETWORK,
    replayStore,
  });

  app.get("/api/image", (req: any, res: any) => {
    paywall(req, res, () => {
      log("SERVICE", "x402", "Image delivered via /api/image");
      res.contentType("image/png").send(imageBuffer);
    });
  });

  app.get("/api/audio", (req: any, res: any) => {
    paywall(req, res, () => {
      log("SERVICE", "x402", "Audio delivered via /api/audio");
      res.contentType("audio/mpeg").send(audioBuffer);
    });
  });

  app.get("/api/gif", (req: any, res: any) => {
    paywall(req, res, () => {
      log("SERVICE", "x402", "GIF delivered via /api/gif");
      res.contentType("image/gif").send(gifBuffer);
    });
  });

  app.get("/", (_req: any, res: any) => {
    res.json({ status: "ok", agent: AGENT_NAME, endpoints: ["/api/image", "/api/audio", "/api/gif"] });
  });

  app.listen(X402_PORT, () => log("SERVICE", "x402", `Server running on port ${X402_PORT}`));

  // ══ Register agent ══
  try {
    const reg = await agent.runAction("register_agent", {
      name: AGENT_NAME,
      description: "Serves images, audio, and GIFs via x402 paid endpoints",
      capabilities: CAPABILITIES,
      endpoint: PUBLIC_URL,
    });
    logSuccess("SERVICE", "REGISTER", `Agent registered: ${JSON.stringify(reg)}`);
  } catch (err: any) {
    if (err.message?.includes("already registered")) {
      log("SERVICE", "REGISTER", "Agent already registered, continuing...");
    } else {
      logError("SERVICE", "REGISTER", err.message);
    }
  }

  // ══ Main loop: poll intents → send offers ══
  log("SERVICE", "LOOP", `Starting poll loop (every ${POLL_INTERVAL / 1000}s)...`);
  const offeredIntents = new Set<number>();

  while (true) {
    try {
      log("SERVICE", "POLL", "Discovering intents...");
      const result = (await agent.runAction("discover_intents", {})) as any;
      const intents = result?.intents || [];
      log("SERVICE", "POLL", `Found ${intents.length} open intents`);

      for (const intent of intents) {
        const idx = intent.intentIndex as number;
        const service = (intent.serviceName || intent.service || "") as string;

        if (offeredIntents.has(idx)) continue;

        // Check if we can serve this intent
        const keywords = ["image", "audio", "gif", "media", "file", "content", "music", "sound", "animation", "picture", "photo"];
        const canServe = keywords.some((kw) => service.toLowerCase().includes(kw));
        if (!canServe) {
          log("SERVICE", "SKIP", `Intent #${idx} (${service}) — not our domain`);
          continue;
        }

        // Pick endpoint based on service type
        let endpoint = `${PUBLIC_URL}/api/image`;
        if (/audio|music|sound/i.test(service)) {
          endpoint = `${PUBLIC_URL}/api/audio`;
        } else if (/gif|animation/i.test(service)) {
          endpoint = `${PUBLIC_URL}/api/gif`;
        }

        // Send offer
        log("SERVICE", "OFFER", `Sending offer on intent #${idx} (${service}): ${OFFER_PRICE} TON`);
        try {
          const offer = await agent.runAction("send_offer", {
            intentIndex: idx,
            price: OFFER_PRICE,
            deliveryTime: 5,
            endpoint,
          });
          offeredIntents.add(idx);
          logSuccess("SERVICE", "OFFER", `Offer sent: ${JSON.stringify(offer)}`);
        } catch (err: any) {
          logError("SERVICE", "OFFER", `Failed on #${idx}: ${err.message}`);
          offeredIntents.add(idx); // Don't retry
        }
      }
    } catch (err: any) {
      logError("SERVICE", "POLL", err.message);
    }

    await sleep(POLL_INTERVAL);
  }
}

main().catch((err) => {
  logError("SERVICE", "FATAL", err.message);
  process.exit(1);
});
