/**
 * CurrencyContext — global EUR/USD display toggle.
 * Session-only (React state, no localStorage).
 * Default: EUR.
 */
import { createContext, useContext, useState } from "react";

export type DisplayCurrency = "EUR" | "USD";

interface CurrencyContextValue {
  displayCurrency: DisplayCurrency;
  setDisplayCurrency: (c: DisplayCurrency) => void;
}

const CurrencyContext = createContext<CurrencyContextValue>({
  displayCurrency: "EUR",
  setDisplayCurrency: () => {},
});

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>("EUR");
  return (
    <CurrencyContext.Provider value={{ displayCurrency, setDisplayCurrency }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency() {
  return useContext(CurrencyContext);
}

/**
 * Format an absolute monetary value using the stored priceEur/priceUsd fields.
 * Shows primary in selected currency + secondary in muted text.
 * Also accepts nativePrice + nativeCurrency for the detail-page third line.
 *
 * Returns an object with { primary, secondary, native } strings for flexibility.
 */
export function formatMonetary(
  priceEur: number | null | undefined,
  priceUsd: number | null | undefined,
  displayCurrency: DisplayCurrency,
  opts?: {
    nativePrice?: number | null;
    nativeCurrency?: string | null;
    compact?: boolean; // use B/M/K shorthand for large numbers
    decimals?: number;
  }
): { primary: string; secondary: string; native: string } {
  const fmt = (n: number, compact: boolean, decimals = 2) => {
    if (compact) {
      if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(1) + "T";
      if (Math.abs(n) >= 1e9)  return (n / 1e9).toFixed(1) + "B";
      if (Math.abs(n) >= 1e6)  return (n / 1e6).toFixed(1) + "M";
      if (Math.abs(n) >= 1e3)  return (n / 1e3).toFixed(0) + "K";
    }
    return n.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  };

  const compact = opts?.compact ?? false;
  const dec = opts?.decimals ?? 2;

  const eurStr = priceEur != null ? "€" + fmt(priceEur, compact, dec) : null;
  const usdStr = priceUsd != null ? "$" + fmt(priceUsd, compact, dec) : null;

  let primary: string;
  let secondary: string;

  if (displayCurrency === "EUR") {
    primary = eurStr ?? usdStr ?? "—";
    secondary = usdStr && eurStr ? "(~" + usdStr + ")" : "";
  } else {
    primary = usdStr ?? eurStr ?? "—";
    secondary = eurStr && usdStr ? "(~" + eurStr + ")" : "";
  }

  // Native reference
  let native = "";
  if (opts?.nativePrice != null && opts?.nativeCurrency) {
    const nc = opts.nativeCurrency;
    const sym =
      nc === "EUR" ? "€" : nc === "USD" ? "$" : nc === "GBP" || nc === "GBp" ? "£" :
      nc === "JPY" ? "¥" : nc === "KRW" ? "₩" : nc === "HKD" ? "HK$" :
      nc === "CNH" || nc === "CNY" ? "¥" : nc === "AUD" ? "A$" :
      nc === "CAD" ? "CA$" : nc === "CHF" ? "Fr" : nc === "SEK" ? "kr" :
      nc === "DKK" ? "kr" : nc === "NOK" ? "kr" : nc === "SGD" ? "S$" :
      nc === "TWD" ? "NT$" : nc === "INR" ? "₹" : nc === "BRL" ? "R$" : nc + " ";
    native = sym + fmt(opts.nativePrice, compact, nc === "JPY" || nc === "KRW" ? 0 : dec) + " native";
  }

  return { primary, secondary, native };
}

/**
 * Convenience: format a price shown in a table cell.
 * Falls back to native price display if no FX data available.
 */
export function formatPrice(
  priceEur: number | null | undefined,
  priceUsd: number | null | undefined,
  nativePrice: number | null | undefined,
  nativeCurrency: string | null | undefined,
  displayCurrency: DisplayCurrency,
  showSecondary = true
): string {
  if (priceEur == null && priceUsd == null) {
    // Fallback: show native with appropriate symbol
    if (nativePrice == null) return "—";
    const nc = nativeCurrency || "USD";
    const sym = nc === "EUR" ? "€" : nc === "GBP" || nc === "GBp" ? "£" : "$";
    return sym + nativePrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const { primary, secondary } = formatMonetary(priceEur, priceUsd, displayCurrency, { decimals: 2 });
  return showSecondary && secondary ? `${primary} ${secondary}` : primary;
}
