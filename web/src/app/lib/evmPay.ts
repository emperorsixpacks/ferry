import { isEvmAddress, type Eip1193 } from "./browserWallet";

// Paying the node from a browser wallet, once the person clicked "Pay with …" (components/
// PayFromWallet, loaded only then): the ERC-20 transfer encoded by hand, the chains a wallet may be
// asked to add, and the raw EIP-1193 requests, with their refusals in plain words. No library.

// ------------------------------------------------------------------------------------------------
// encoding

const word = (hex: string) => hex.padStart(64, "0");
const MAX_UINT = (1n << 256n) - 1n;
export const toHex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
// a JSON-RPC quantity or a 32-byte word → a number; null when it isn't one ("0x" too: no contract)
export const fromHex = (v: unknown): bigint | null => (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null);

// ERC-20 transfer(address to, uint256 amount): selector 0xa9059cbb, then both as 32-byte words
export function transferData(to: string, amount: bigint): string {
  if (!isEvmAddress(to)) throw new Error("not an address");
  if (amount <= 0n || amount > MAX_UINT) throw new Error("not an amount");
  return `0xa9059cbb${word(to.slice(2).toLowerCase())}${word(amount.toString(16))}`;
}

// ERC-20 balanceOf(address owner): selector 0x70a08231
export const balanceOfData = (owner: string) => `0x70a08231${word(owner.slice(2).toLowerCase())}`;

// ------------------------------------------------------------------------------------------------
// chains

export interface KnownChain {
  name: string;
  explorer: string;
  explorerName: string;
  // the chain operator's own public RPC, for wallet_addEthereumChain; null for Ethereum and Sepolia:
  // every wallet ships them (MetaMask refuses to add them again), and no operator runs one for them
  rpc: string | null;
}

export const KNOWN_CHAINS: Record<number, KnownChain> = {
  1: { name: "Ethereum", explorer: "https://etherscan.io", explorerName: "Etherscan", rpc: null },
  11155111: { name: "Sepolia", explorer: "https://sepolia.etherscan.io", explorerName: "Etherscan", rpc: null },
  8453: { name: "Base", explorer: "https://basescan.org", explorerName: "Basescan", rpc: "https://mainnet.base.org" },
  84532: { name: "Base Sepolia", explorer: "https://sepolia.basescan.org", explorerName: "Basescan", rpc: "https://sepolia.base.org" },
  42161: { name: "Arbitrum One", explorer: "https://arbiscan.io", explorerName: "Arbiscan", rpc: "https://arb1.arbitrum.io/rpc" },
  421614: { name: "Arbitrum Sepolia", explorer: "https://sepolia.arbiscan.io", explorerName: "Arbiscan", rpc: "https://sepolia-rollup.arbitrum.io/rpc" },
  10: { name: "OP Mainnet", explorer: "https://optimistic.etherscan.io", explorerName: "Etherscan", rpc: "https://mainnet.optimism.io" },
  11155420: { name: "OP Sepolia", explorer: "https://sepolia-optimism.etherscan.io", explorerName: "Etherscan", rpc: "https://sepolia.optimism.io" },
};

export const txLink = (chainId: number, hash: string) => {
  const c = KNOWN_CHAINS[chainId];
  return c && /^0x[0-9a-fA-F]{64}$/.test(hash) ? { href: `${c.explorer}/tx/${hash}`, name: c.explorerName } : null;
};

// ------------------------------------------------------------------------------------------------
// talking to the wallet

// Why a step stopped, for plainError, when it isn't the wallet's own error: no account (locked), a
// chain the wallet doesn't know and Ferry won't add, or the wallet left on another chain.
export class PayError extends Error {
  constructor(public reason: "locked" | "unknown-chain" | "wrong-chain") {
    super(reason);
  }
}

// the EIP-1193 code of a wallet's error (MetaMask mobile nests it in data.originalError)
export function codeOf(e: unknown): number | null {
  const x = e as { code?: unknown; data?: { originalError?: { code?: unknown } } } | null;
  const c = x?.data?.originalError?.code ?? x?.code;
  return typeof c === "number" ? c : null;
}
const messageOf = (e: unknown) => String((e as { message?: unknown } | null)?.message ?? "");
const cancelled = (e: unknown) => codeOf(e) === 4001 || /user (rejected|denied)|rejected by user|ACTION_REJECTED/i.test(messageOf(e));

// eth_requestAccounts: the account the person picked (the wallet asks them; locked: none)
export async function connect(p: Eip1193): Promise<string> {
  const accounts = await p.request({ method: "eth_requestAccounts" });
  const a = Array.isArray(accounts) ? accounts.find(isEvmAddress) : undefined;
  if (!a) throw new PayError("locked");
  return a;
}

export async function chainOf(p: Eip1193): Promise<number | null> {
  const v = fromHex(await p.request({ method: "eth_chainId" }).catch(() => null));
  return v == null ? null : Number(v);
}

// Puts the wallet on `chainId`: switches; a chain it doesn't know is added only when it is a public
// one listed above, with its operator's RPC and explorer (a local chain such as anvil: the person adds
// it themselves). A switch the person turns down: PayError wrong-chain. Throws the wallet's error.
export async function ensureChain(p: Eip1193, chainId: number): Promise<void> {
  if ((await chainOf(p)) === chainId) return;
  const id = toHex(chainId);
  try {
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: id }] });
    } catch (e) {
      if (codeOf(e) !== 4902 && !/unrecognized chain|unknown chain/i.test(messageOf(e))) throw e;
      const c = KNOWN_CHAINS[chainId];
      if (!c?.rpc) throw new PayError("unknown-chain");
      await p.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: id, chainName: c.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [c.rpc], blockExplorerUrls: [c.explorer] }],
      });
      if ((await chainOf(p)) !== chainId) await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: id }] });
    }
  } catch (e) {
    throw cancelled(e) ? new PayError("wrong-chain") : e;
  }
  if ((await chainOf(p)) !== chainId) throw new PayError("wrong-chain");
}

// What `owner` holds, read through the wallet: a token's balanceOf, or ETH. null: it couldn't say.
export async function walletBalance(p: Eip1193, owner: string, token: string | null): Promise<bigint | null> {
  try {
    const v = token ? await p.request({ method: "eth_call", params: [{ to: token, data: balanceOfData(owner) }, "latest"] }) : await p.request({ method: "eth_getBalance", params: [owner, "latest"] });
    return fromHex(v);
  } catch {
    return null;
  }
}

// The transaction the wallet is asked to sign: a token goes to its contract with the node's account
// inside the transfer call; ETH goes to the node's account. The wallet estimates the gas.
export function payTx(from: string, node: string, token: string | null, amount: bigint): { from: string; to: string; data?: string; value?: string } {
  if (!isEvmAddress(from) || !isEvmAddress(node) || (token != null && !isEvmAddress(token))) throw new Error("not an address");
  if (amount <= 0n) throw new Error("not an amount");
  return token ? { from, to: token, data: transferData(node, amount) } : { from, to: node, value: toHex(amount) };
}

// "0x1": it went through; "0x0": the chain reverted it; null: not mined yet (or the wallet couldn't say)
export async function receiptOf(p: Eip1193, hash: string): Promise<"ok" | "reverted" | null> {
  try {
    const r = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: unknown } | null;
    if (!r) return null;
    return r.status === "0x1" || r.status === 1 ? "ok" : r.status === "0x0" || r.status === 0 ? "reverted" : null;
  } catch {
    return null;
  }
}

// A wallet's refusal, for people.
export function plainError(e: unknown, wallet: string, network: string, chainId: number, ticker: string): string {
  if (e instanceof PayError) {
    if (e.reason === "locked") return `${wallet} is locked. Unlock it and try again.`;
    if (e.reason === "unknown-chain") return `${wallet} doesn't know ${network} (chain ID ${chainId}). Add that network in ${wallet}, then try again.`;
    return `${wallet} is on another network, so nothing was sent. Switch it to ${network} and try again.`;
  }
  const code = codeOf(e);
  const msg = messageOf(e);
  if (cancelled(e)) return `You cancelled in ${wallet}. Nothing was sent.`;
  if (code === 4100) return `${wallet} is locked, or hasn't allowed this page. Unlock it and try again.`;
  if (code === -32002) return `${wallet} is already asking you something. Open it to carry on.`;
  if (/insufficient funds/i.test(msg)) return `Not enough ETH in ${wallet} on ${network} to ${ticker === "ETH" ? "send that and pay" : "pay"} the gas. Nothing was sent.`;
  return `${wallet} said: ${msg.replace(/\s+/g, " ").slice(0, 160) || "something went wrong"}. Nothing was sent.`;
}
