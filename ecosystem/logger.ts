// ecosystem/logger.ts — Shared logger for ecosystem bots

const COLORS: Record<string, string> = {
  SERVICE: "\x1b[36m",    // cyan
  ARBITER: "\x1b[33m",    // yellow
  BUYER: "\x1b[32m",      // green
  ECOSYSTEM: "\x1b[35m",  // magenta
  ERROR: "\x1b[31m",      // red
  RESET: "\x1b[0m",
};

function getColor(bot: string): string {
  for (const prefix of ["SERVICE", "ARBITER", "BUYER", "ECOSYSTEM"]) {
    if (bot.startsWith(prefix)) return COLORS[prefix];
  }
  return COLORS.RESET;
}

export function log(bot: string, action: string, detail: string) {
  const time = new Date().toISOString().slice(11, 19);
  const color = getColor(bot);
  console.log(`${color}[${time}] [${bot}] ${action}: ${detail}${COLORS.RESET}`);
}

export function logError(bot: string, action: string, error: string) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`${COLORS.ERROR}[${time}] [${bot}] ❌ ${action}: ${error}${COLORS.RESET}`);
}

export function logSuccess(bot: string, action: string, detail: string) {
  const time = new Date().toISOString().slice(11, 19);
  const color = getColor(bot);
  console.log(`${color}[${time}] [${bot}] ✅ ${action}: ${detail}${COLORS.RESET}`);
}

export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
