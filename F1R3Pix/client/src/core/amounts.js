// The amount sent to several selected players (design D7): "each" sends the
// amount to every recipient; "split" divides it, and is refused unless it
// divides evenly in the vault's base unit.

export function planPayment({ mode, amount, recipients }) {
  const n = recipients.length;
  if (n < 1) return { error: "select at least one player" };
  if (n > 64) return { error: "at most 64 players at once" };
  if (!Number.isSafeInteger(amount) || amount < 1) return { error: "enter a whole, positive amount" };
  if (mode === "each") {
    return { transfers: recipients.map((a) => [a, amount]), total: amount * n, each: amount, line: `${amount} each to ${n} player${n > 1 ? "s" : ""}: ${amount * n} F1R3Cap` };
  }
  if (mode !== "split") return { error: `unknown mode ${mode}` };
  if (amount % n !== 0) {
    const lower = amount - (amount % n);
    const upper = lower + n;
    return { error: `${amount} does not split evenly among ${n}`, suggestions: [lower, upper].filter((x) => x > 0) };
  }
  const each = amount / n;
  return { transfers: recipients.map((a) => [a, each]), total: amount, each, line: `${amount} split among ${n} player${n > 1 ? "s" : ""}: ${each} each` };
}
