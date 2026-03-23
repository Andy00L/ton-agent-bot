import { Address } from "@ton/core";

// ── Verbose logging ──
let VERBOSE = false;
export function setVerbose(v: boolean) { VERBOSE = v; }
export function verboseLog(category: string, action: string, detail: string) {
  if (!VERBOSE) return;
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] [${category}] ${action}: ${detail}`);
}

// ── Helpers ──
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function friendlyAddr(raw: string, testnet: boolean = true): string {
  try {
    return Address.parse(raw).toString({ bounceable: false, testOnly: testnet });
  } catch {
    return raw;
  }
}

export function shortAddr(addr: string): string {
  if (!addr) return "unknown";
  if (addr.length > 20) return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  return addr;
}

export function formatTon(amount: string | number): string {
  return parseFloat(String(amount)).toFixed(4);
}

export async function safeReply(ctx: any, text: string, extra?: any) {
  verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "REPLY", String(text).replace(/<[^>]+>/g, "").slice(0, 100));
  try {
    return await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
  } catch {
    // Double-fallback: strip tags → generic message
    try {
      return await ctx.reply(text.replace(/<[^>]+>/g, ""), {
        link_preview_options: { is_disabled: true },
        ...extra,
      });
    } catch {
      return await ctx.reply("Done. (response too complex to display)");
    }
  }
}

export async function safeEdit(ctx: any, text: string, opts?: any): Promise<void> {
  verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "EDIT", String(text).replace(/<[^>]+>/g, "").slice(0, 100));
  try {
    await ctx.editMessageText(text, opts);
  } catch (err: any) {
    if (err?.description?.includes("message is not modified")) return;
    if (err?.description?.includes("message to edit not found")) return;
    throw err;
  }
}
