import type { ReactNode } from "react";
import { Link } from "@/router";

// The questions people ask, answered plainly. Help shows them all by group; the landing page
// shows the five marked `landing`. Facts follow docs/THREAT-MODEL.md (the /safety page) and
// docs/WHAT-IS-REAL.md (what has run, and where).

export interface Faq {
  q: string;
  a: ReactNode;
  landing?: boolean;
}

const A = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className="font-medium text-accent-700 underline underline-offset-4 hover:text-accent-800">
    {children}
  </Link>
);

export const FAQ_GROUPS: { title: string; items: Faq[] }[] = [
  {
    title: "Getting started",
    items: [
      {
        q: "What is Ferry?",
        a: "Ferry swaps shielded ZEC for Bitcoin, Litecoin, USDC or ETH, either way round, directly with another person, your swap partner. There is no account, no exchange and no bridge in the middle: each side locks its own coins, and the swap releases both together.",
      },
      {
        q: "How do I make a swap?",
        a: "To sell ZEC, enter how much, pick the coin you want, and press Sell ZEC. To buy ZEC, press the arrow between the two boxes first, then pick the coin you pay with, enter how much ZEC you want, and press Buy ZEC. Ferry finds the partner with the best rate for your amount. Then wait while both chains confirm it; the card says about how long. You can close the page; your Ferry node finishes the swap.",
      },
      {
        q: "What is my Ferry node?",
        a: "The small program that holds your keys and does the swap for you. This app talks to it; your coins never pass through a Ferry server, because there isn't one. On the public demo we run a node with test coins for you, and the partner on the other side too, so you can try it without installing anything.",
      },
      {
        q: "Why is there no “Connect wallet” button?",
        a: "Because a swap needs things no wallet can do: one-time keys shared between you and your partner, and someone online at the deadlines to claim or refund. Your Ferry node does both. Connecting a wallet would also tell a website who you are, and Ferry never asks. You still use your own wallet, such as Zodl: on your own node, scan the code on the Wallet page to add funds, and paste your Zodl address in “Receive to” so the ZEC you buy lands there, still shielded. MetaMask and Bitcoin wallets work the same way. For USDC or ETH on your own node, Add funds can also fill the transfer in MetaMask for you (“Pay with MetaMask”). Ferry doesn't keep the address it pays from; the transfer itself is public on its chain, like any payment.",
      },
      {
        q: "Who is my swap partner?",
        a: (
          <>
            Someone who offers the other coin at a rate they set. Ferry picks the best rate for your amount; to choose another partner, open the settings (the gear above the swap card). A partner can't take
            your coins: the most they can do is not finish, and then your coins come back. Today every partner is run by the Ferry team: one per pair on the public demo, at a
            fixed test rate, and your own node swaps between its own two wallets until outside partners are listed. Each partner runs a few swaps at once (4 on test networks, 2 on
            mainnet), as far as its coins go. When every one is full, the swap card says the partner is busy, and how long a swap usually takes: it has room again when one finishes.
          </>
        ),
      },
    ],
  },
  {
    title: "Privacy",
    items: [
      {
        q: "Is it really private?",
        landing: true,
        a: "Yes. Your ZEC stays in Zcash's shielded pool the whole time, so its amount, sender and receiver are encrypted. On Bitcoin and Litecoin a finished swap looks like an ordinary payment; on Base it is a visible call to Ferry's swap contract. Nothing on either chain links the two sides.",
      },
      {
        q: "What does my swap partner learn?",
        a: "The amounts and the deadline you agreed on, and that your ZEC reached the shared address made for this swap. Not where the ZEC goes afterwards, and not your balance, other addresses or history. They do see your IP address, because the two Ferry nodes talk directly; use Tor or a VPN if that matters to you.",
      },
    ],
  },
  {
    title: "If something goes wrong",
    items: [
      {
        q: "What if the other side disappears?",
        landing: true,
        a: "Every swap has deadlines. If your partner stops before the end, the swap is called off when a deadline passes, and your Ferry node takes your coins back while it runs. If they stop after you've locked your ZEC, you take their coin instead. Nobody can end up with both sides.",
      },
      {
        q: "My swap says “Cancelling”. Did I lose anything?",
        a: "No. Cancelling means the swap didn't finish in time and is being undone. The swap's page shows when your coins will be back.",
      },
      {
        q: "What if my computer goes offline?",
        a: "Keep your Ferry node running until the swap is done. If you are selling ZEC and go offline, you still get your ZEC back later. If you are buying ZEC and stay offline past the final deadline, you can lose what you locked. A watchtower can keep the deadlines for you while you're away.",
      },
      {
        q: "Is it safe to use with real money?",
        a: (
          <>
            Not yet. Ferry has run on test networks only (14 live swaps on public test networks, and local tests) and hasn't been independently reviewed. Its
            cross-chain proof is unaudited, so a node's mainnet mode caps each swap at 0.02 ZEC. <A to="/safety">Safety details</A> lists every known limit.
          </>
        ),
      },
    ],
  },
  {
    title: "Fees and time",
    items: [
      {
        q: "How long does it take?",
        landing: true,
        a: "Minutes, not seconds: each side waits for the other's lock to confirm, mostly Zcash's. On the test networks: about 2 to 10 minutes with USDC on Base Sepolia (our live test swap took about 7), 20 to 40 with Bitcoin on signet, 10 to 20 with Litecoin. On mainnet, where Ferry offers Base only for now, about 15 to 20 minutes. The swap card shows the estimate for your network.",
      },
      {
        q: "What does it cost?",
        landing: true,
        a: "Ferry charges nothing. Your partner's rate is the price you get, and the swap card shows exactly what you receive. On top there are the usual network fees: a small Bitcoin or Litecoin fee taken from what you get, or a little ETH for gas on Base, and a tiny Zcash fee.",
      },
      {
        q: "Is there a smallest or largest swap?",
        a: "Each partner sets the amounts it takes. If yours doesn't fit any partner, the swap card says so and shows the limit.",
      },
    ],
  },
  {
    title: "Coins and chains",
    items: [
      {
        q: "Which coins and chains?",
        landing: true,
        a: "Shielded ZEC for Bitcoin, Litecoin, and USDC or ETH on Base. Bitcoin and Litecoin stay on test networks for now. Each server offers some of these; the coin list shows which ones you can pick here.",
      },
      {
        q: "Why WETH instead of ETH?",
        a: "The swap contract works with tokens, so ETH comes as WETH: ETH in token form, always worth exactly 1 ETH, which most wallets unwrap in one step. One swap can carry up to about 18.4 WETH.",
      },
      {
        q: "What about Solana, USDT, NEAR and the rest?",
        a: "The coin list ends with “More via NEAR Intents”: assets on many other chains, reached through NEAR Intents. Ferry swaps your shielded ZEC for a coin it supports, and NEAR Intents carries that on to the asset you picked, or the other way round. It works on mainnet only, on your own node, and hasn't been run with real funds yet; the public demo shows its prices only. See NEAR Intents below.",
      },
      {
        q: "Can I buy ZEC instead?",
        a: "Yes. Press the arrow between Sell and Buy on the swap page. You pay with the Bitcoin, Litecoin or tokens in your Ferry node, and the ZEC arrives shielded in its wallet. You lock your coins first; if your partner never locks the ZEC, your coins come back after the deadline. Ferry remembers which way you last swapped.",
      },
    ],
  },
  {
    title: "NEAR Intents",
    items: [
      {
        q: "What does “via NEAR Intents” mean?",
        a: "NEAR Intents is a cross-chain swap network that reaches assets Ferry doesn't swap itself. A swap marked “via NEAR Intents” has two parts. Selling ZEC: Ferry swaps your shielded ZEC for a coin it supports (USDC on Base, say) and pays it straight into a NEAR Intents deposit address; NEAR Intents swaps that for the asset you picked and sends it to the address you gave. Buying ZEC: you send your asset to a NEAR Intents deposit address, NEAR Intents delivers the coin to your Ferry node, and Ferry buys the ZEC with it. The swap card picks the route that gives you the most.",
      },
      {
        q: "Does my ZEC go to NEAR Intents?",
        a: "No. Ferry never sends ZEC to NEAR Intents (its ZEC deposit addresses are transparent, which would undo the privacy). Your ZEC moves only inside Zcash's shielded pool, in an atomic swap with a Ferry partner, exactly as in any other Ferry swap. Only the other coin goes through NEAR Intents.",
      },
      {
        q: "Who do I trust for the NEAR part?",
        a: "NEAR Intents. The Ferry part is atomic: nobody can take your coins. The NEAR part runs on NEAR Intents' bridges and solvers, on public chains: the deposit address, the amounts and your destination address are visible to anyone, and you rely on NEAR Intents to deliver or refund. Ferry's server checks that every NEAR Intents quote is signed by NEAR Intents before it uses it, and keeps the signed quote, which is your record if you ever need to dispute a swap. Ferry's privacy story covers the ZEC side; the NEAR side is as private as any public swap.",
      },
      {
        q: "What if the NEAR part fails?",
        a: "You get coins back either way. Selling: if the Ferry swap stops, your ZEC comes back to your shielded wallet and nothing reaches NEAR Intents; if NEAR Intents can't fill the swap at the quoted price, it refunds the coin to your own Ferry node. Buying: if NEAR Intents can't fill it, it refunds your asset to the refund address you gave; if the Ferry swap then stops, the coin stays in your Ferry node, and you can try the ZEC again or keep it.",
      },
      {
        q: "Why only on my own node, and only on mainnet?",
        a: "A NEAR swap pays out to an address you type, so it has to run on a Ferry node with your own coins, never on someone else's demo. And NEAR Intents runs on the main networks only. On the public demo, which runs on test networks, you can see NEAR Intents' assets and live quotes, but not swap them.",
      },
      {
        q: "What does the NEAR part cost?",
        a: "NEAR Intents' own fees, already counted in the quote: what the swap card shows is what you get. A server without a NEAR Intents partner key pays about 0.25% more. Ferry adds nothing on top.",
      },
    ],
  },
];

export const LANDING_FAQ: Faq[] = FAQ_GROUPS.flatMap((g) => g.items).filter((f) => f.landing);
