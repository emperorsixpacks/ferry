import { useEffect, useState } from "react";

// Paying your own Ferry node from a browser wallet (MetaMask, Rabby, ...), for /wallet's Add funds on
// an EVM coin. No library: wallets are found here with EIP-6963 (else the injected window.ethereum);
// lib/evmPay speaks to them with raw EIP-1193 requests and encodes the ERC-20 transfer itself. No
// WalletConnect: its relay sees the IP and the address of everyone who pays.
// The wallet's address lives in the page's memory only: it goes to the wallet itself and nowhere else
// (not to Ferry's server, not to the node, not to localStorage).

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...args: never[]) => void): void;
  removeListener?(event: string, fn: (...args: never[]) => void): void;
}

export interface BrowserWallet {
  id: string;
  name: string;
  // the wallet's own icon, as the data: URI it announced (never fetched from the web), or null
  icon: string | null;
  provider: Eip1193;
}

// ------------------------------------------------------------------------------------------------
// finding the wallet

const found = new Map<string, BrowserWallet>();
const listeners = new Set<() => void>();
let listening = false;

const cleanName = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
  return t || null;
};
// an image the wallet carries itself; anything else (an https URL would be fetched) is dropped
const cleanIcon = (v: unknown): string | null => (typeof v === "string" && v.length < 200_000 && /^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/i.test(v) ? v : null);

function onAnnounce(e: Event) {
  const d = (e as CustomEvent<{ info?: { uuid?: string; name?: string; icon?: string; rdns?: string }; provider?: Eip1193 }>).detail;
  const name = cleanName(d?.info?.name);
  if (!d?.provider || typeof d.provider.request !== "function" || !name) return;
  const id = String(d.info?.rdns || d.info?.uuid || name);
  if (found.has(id)) return;
  found.set(id, { id, name, icon: cleanIcon(d.info?.icon), provider: d.provider });
  listeners.forEach((f) => f());
}

// a wallet that only injects window.ethereum (no EIP-6963): its name from the flags wallets set
function injected(): BrowserWallet | null {
  const eth = (window as unknown as { ethereum?: Eip1193 & Record<string, unknown> }).ethereum;
  if (!eth || typeof eth.request !== "function") return null;
  const name = eth.isRabby ? "Rabby" : eth.isCoinbaseWallet ? "Coinbase Wallet" : eth.isBraveWallet ? "Brave Wallet" : eth.isMetaMask ? "MetaMask" : "your wallet";
  return { id: "injected", name, icon: null, provider: eth };
}

const isMetaMask = (w: BrowserWallet) => w.id === "io.metamask" || /^metamask$/i.test(w.name);

// The browser's wallet, once the page asks (`on`): MetaMask when it is there, else the first that
// announced itself, else an injected window.ethereum. null: none (and then the page offers nothing).
export function useBrowserWallet(on: boolean): BrowserWallet | null {
  const [, setSeen] = useState(0);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!on) return;
    const f = () => setSeen((n) => n + 1);
    listeners.add(f);
    if (!listening) {
      window.addEventListener("eip6963:announceProvider", onAnnounce);
      listening = true;
    }
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // wallets answer at once; an older one only injects window.ethereum
    const t = setTimeout(() => setWaited(true), 400);
    return () => {
      listeners.delete(f);
      clearTimeout(t);
    };
  }, [on]);
  if (!on) return null;
  const all = [...found.values()];
  return all.find(isMetaMask) ?? all[0] ?? (waited ? injected() : null);
}

// ------------------------------------------------------------------------------------------------
// addresses

export const isEvmAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
