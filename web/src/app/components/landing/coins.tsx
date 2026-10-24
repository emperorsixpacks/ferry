import type { ChainId } from "@/api";
import { ChainLogo, TokenLogo } from "../Logos";
import { cn } from "../../lib/utils";

// The coins the landing draws: a coin's mark, with its chain's badge for a token (USDC on Base,
// ETH on Arbitrum), like PairLogo but with ether's own mark, since the landing says ETH.

export interface Coin {
  token: "btc" | "ltc" | "usdc" | "eth";
  chain?: ChainId;
  ticker: string;
  name: string;
}

export const BTC: Coin = { token: "btc", ticker: "BTC", name: "Bitcoin" };
export const LTC: Coin = { token: "ltc", ticker: "LTC", name: "Litecoin" };
const CHAIN: Record<ChainId, string> = { base: "Base", ethereum: "Ethereum", arbitrum: "Arbitrum", optimism: "Optimism" };
export const usdc = (chain: ChainId): Coin => ({ token: "usdc", chain, ticker: "USDC", name: `USDC on ${CHAIN[chain]}` });
export const eth = (chain: ChainId): Coin => ({ token: "eth", chain, ticker: "ETH", name: `ETH on ${CHAIN[chain]}` });

export function CoinMark({ coin, size = 32, className }: { coin: Coin; size?: number; className?: string }) {
  const badge = Math.round(size * 0.46);
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }} aria-hidden>
      <TokenLogo id={coin.token} size={size} />
      {coin.chain && !(coin.token === "eth" && coin.chain === "ethereum") ? (
        <span className="absolute -right-1 -bottom-1 inline-flex rounded-full bg-white p-[1.5px]">
          <ChainLogo id={coin.chain} size={badge} />
        </span>
      ) : null}
    </span>
  );
}
