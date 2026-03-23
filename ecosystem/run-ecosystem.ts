// ecosystem/run-ecosystem.ts
// Launches all ecosystem bots in parallel with staggered starts

import { log, logError, sleep } from "./logger";

async function main() {
  log("ECOSYSTEM", "INIT", "═══════════════════════════════════════");
  log("ECOSYSTEM", "INIT", "  TON Agent Kit — Demo Ecosystem");
  log("ECOSYSTEM", "INIT", "  Service Provider (port 4001)");
  log("ECOSYSTEM", "INIT", "  3 Arbiters");
  log("ECOSYSTEM", "INIT", "  1 Buyer");
  log("ECOSYSTEM", "INIT", "═══════════════════════════════════════");

  const procs: ReturnType<typeof Bun.spawn>[] = [];

  const ip = await fetch('https://api.ipify.org').then(r => r.text());
  const serviceUrl = `http://${ip}:4001`;
  log("ECOSYSTEM", "NETWORK", `Public URL: ${serviceUrl}`);

  log("ECOSYSTEM", "LAUNCH", "Starting service-bot...");
  procs.push(
    Bun.spawn(["bun", "run", "ecosystem/service-bot.ts"], {
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, SERVICE_URL: serviceUrl },
    }),
  );
  await sleep(10_000); // Let service register + start x402 server

  // Verify service-bot didn't crash during startup
  if (procs[0].exitCode !== null) {
    logError("ECOSYSTEM", "LAUNCH", `service-bot crashed (exit ${procs[0].exitCode}), aborting`);
    process.exit(1);
  }

  log("ECOSYSTEM", "LAUNCH", "Starting arbiter-bot (3 arbiters)...");
  procs.push(
    Bun.spawn(["bun", "run", "ecosystem/arbiter-bot.ts"], {
      stdio: ["inherit", "inherit", "inherit"],
    }),
  );
  await sleep(10_000); // Let arbiters register

  log("ECOSYSTEM", "LAUNCH", "Starting buyer-bot...");
  procs.push(
    Bun.spawn(["bun", "run", "ecosystem/buyer-bot.ts"], {
      stdio: ["inherit", "inherit", "inherit"],
    }),
  );

  log("ECOSYSTEM", "RUNNING", "All bots launched. Press CTRL+C to stop.");

  const shutdown = () => {
    log("ECOSYSTEM", "SHUTDOWN", "Stopping all bots...");
    for (const p of procs) {
      try {
        p.kill();
      } catch {}
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  while (true) {
    await sleep(60_000);
  }
}

main();
