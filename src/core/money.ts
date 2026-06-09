const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

export function assertSafeNumber(value: bigint, field = "quantity"): number {
  if (value > MAX_SAFE || value < MIN_SAFE) {
    throw new RangeError(`${field} exceeds JavaScript safe integer range`);
  }
  return Number(value);
}

export function finiteDecimalText(value: number | string | bigint): string {
  const text = typeof value === "bigint" ? value.toString() : String(value).trim();
  if (!/^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
    throw new Error(`Invalid decimal amount: ${String(value)}`);
  }
  if (/e/i.test(text)) {
    const number = Number(text);
    if (!Number.isFinite(number)) throw new Error(`Invalid decimal amount: ${String(value)}`);
    return number.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
  }
  return text;
}

export function toAtomicUnits(value: number | string | bigint, scale: number): bigint {
  if (typeof value === "bigint") return value;
  const text = finiteDecimalText(value);
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  const [wholeRaw, fracRaw = ""] = unsigned.split(".");
  const whole = BigInt(wholeRaw || "0");
  const padded = (fracRaw + "0".repeat(scale + 1)).slice(0, scale + 1);
  const kept = padded.slice(0, scale) || "0";
  const guard = Number(padded[scale] ?? "0");
  let out = whole * 10n ** BigInt(scale) + BigInt(kept);
  if (guard >= 5) out += 1n;
  return negative ? -out : out;
}

export function fromAtomicUnits(quantity: bigint, scale: number): string {
  const negative = quantity < 0n;
  const value = negative ? -quantity : quantity;
  const factor = 10n ** BigInt(scale);
  const whole = value / factor;
  const fraction = (value % factor).toString().padStart(scale, "0");
  const body = scale === 0 ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

export function decimalToScaled(value: number | string | bigint, maxScale = 18): { value: bigint; scale: number } {
  if (typeof value === "bigint") return { value, scale: 0 };
  const text = finiteDecimalText(value).replace(/^\+/, "");
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^-/, "");
  const [wholeRaw, fracRaw = ""] = unsigned.split(".");
  const trimmedFrac = fracRaw.slice(0, maxScale).replace(/0+$/, "");
  const scale = trimmedFrac.length;
  const intText = `${wholeRaw || "0"}${trimmedFrac || ""}`;
  const scaled = BigInt(intText || "0");
  return { value: negative ? -scaled : scaled, scale };
}

export function scaledToNumber(value: bigint, scale: number): number {
  return Number(fromAtomicUnits(value, scale));
}

export function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;
  return negative ? -quotient : quotient;
}

export function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1n;
}

export function reduceRatio(numerator: bigint, denominator: bigint): { numerator: bigint; denominator: bigint } {
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

