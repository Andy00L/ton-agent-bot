import express from "express";
import {
  tonPaywall,
  FileReplayStore,
} from "@ton-agent-kit/x402-middleware";
import type { BotContext } from "../context";
import { NETWORK } from "../config";
import { getUserAgent } from "./agent";

// Detect if an action result contains binary data that should be served natively
function isBinaryActionResult(data: any): data is { contentType: string; data: Buffer | Uint8Array } {
  if (!data || typeof data !== "object") return false;
  const ct = data.contentType;
  if (typeof ct !== "string") return false;
  if (!(Buffer.isBuffer(data.data) || data.data instanceof Uint8Array)) return false;
  return /^(image|audio|video)\//i.test(ct) || ct === "application/pdf" || ct === "application/octet-stream";
}

export function setupX402Server(ctx: BotContext): ReturnType<ReturnType<typeof express>["listen"]> {
  const app = express();
  const replayStore = new FileReplayStore("data/.x402-bot-hashes.json");
  const userReplayStores = new Map<number, FileReplayStore>();
  function getReplayStore(uid: number): FileReplayStore {
    if (!userReplayStores.has(uid)) userReplayStores.set(uid, new FileReplayStore(`data/.x402-user-${uid}-hashes.json`));
    return userReplayStores.get(uid)!;
  }

  // Cache middleware instances so verifiedPayments cache + TOCTOU guard persist across requests
  const paywallCache = new Map<string, ReturnType<typeof tonPaywall>>();
  function getCachedPaywall(key: string, config: Parameters<typeof tonPaywall>[0]): ReturnType<typeof tonPaywall> {
    if (!paywallCache.has(key)) {
      paywallCache.set(key, tonPaywall(config));
    }
    return paywallCache.get(key)!;
  }

  const X402_SERVICES: Record<string, { action: string; params: Record<string, any>; price: string; description: string }> = {
    price: { action: "get_price", params: { token: "TON" }, price: "0.005", description: "TON price data" },
    analytics: { action: "get_portfolio_metrics", params: { days: 7 }, price: "0.01", description: "7-day portfolio" },
    balance: { action: "get_balance", params: {}, price: "0.002", description: "Balance check" },
  };

  app.get("/", (_req, res) => {
    const eps: any[] = [];
    for (const [p, c] of ctx.endpointRoutes) eps.push({ path: p, price: c.price + " TON", description: c.description, served: c.served });
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
    const walletAddr = ctx.secretStore.getWalletAddress(uid);
    if (!walletAddr) return res.status(404).json({ error: "User not found" });
    const config = X402_SERVICES[service];
    if (!config) return res.status(404).json({ error: "Unknown service", available: Object.keys(X402_SERVICES) });
    const cacheKey = `user:${walletAddr}:${config.price}`;
    getCachedPaywall(cacheKey, { recipient: walletAddr, amount: config.price, network: NETWORK, replayStore: getReplayStore(uid) })(req, res, async () => {
      try {
        const userAgent = await getUserAgent(ctx, uid);
        const data = await userAgent.runAction(config.action, config.params);
        if (isBinaryActionResult(data)) {
          res.setHeader("Content-Type", data.contentType);
          res.send(Buffer.isBuffer(data.data) ? data.data : Buffer.from(data.data));
        } else {
          res.json({ service, data, provider: uid, timestamp: new Date().toISOString() });
        }
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });
  });

  // Legacy endpoint routes (dev agent)
  app.use(async (req: any, res: any, next: any) => {
    const route = ctx.endpointRoutes.get(req.path);
    if (!route) return next();
    const cacheKey = `legacy:${req.path}:${route.price}`;
    getCachedPaywall(cacheKey, { amount: route.price, recipient: ctx.devAddress, network: NETWORK, description: route.description, replayStore })(req, res, async () => {
      try {
        const merged: Record<string, any> = { ...route.dataParams };
        for (const [k, v] of Object.entries(req.query)) { if (typeof v === "string" && v.length > 0) merged[k] = v; }
        const data = await ctx.readOnlyAgent.runAction(route.dataAction, merged);
        route.served++;
        if (isBinaryActionResult(data)) {
          res.setHeader("Content-Type", data.contentType);
          res.send(Buffer.isBuffer(data.data) ? data.data : Buffer.from(data.data));
        } else {
          res.json({ source: "telegram-bot", fetchedAt: new Date().toISOString(), ...data });
        }
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });
  });
  app.use((_req: any, res: any) => { res.status(404).json({ error: "No endpoint here", available: Array.from(ctx.endpointRoutes.keys()) }); });
  const x402Server = app.listen(ctx.x402Port);
  return x402Server;
}
