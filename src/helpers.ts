// ── Helpers ──
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function shortAddr(addr: string): string {
  if (!addr) return "unknown";
  if (addr.length > 20) return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
  return addr;
}
export function formatTon(amount: string | number): string {
  return parseFloat(String(amount)).toFixed(4);
}

export async function safeReply(ctx: any, text: string, extra?: any) {
  try {
    await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
  } catch {
    // FIX #4: Double-fallback: strip tags → generic message
    try {
      await ctx.reply(text.replace(/<[^>]+>/g, ""), {
        link_preview_options: { is_disabled: true },
        ...extra,
      });
    } catch {
      await ctx.reply("Done. (response too complex to display)");
    }
  }
}
