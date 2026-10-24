import type { ReactNode } from "react";
import { Link } from "@/router";

// The questions people ask, answered plainly. Help shows them all by group; the landing page
// shows the five marked `landing`. Facts follow docs/THREAT-MODEL.md (the /safety page).

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
        a: "Ferry swaps your shielded ZEC for Bitcoin, Litecoin, USDC or ETH directly with another person, your swap partner. There is no account, no exchange and no bridge in the middle: each side locks its own coins, and the swap releases both together.",
      },
      {
        q: "How do I make a swap?",
        a: "Enter how much ZEC to sell, pick the coin you want, and press Swap. Ferry finds the partner with the best rate for your amount. Then wait a few minutes. You can close the page; your Ferry node finishes the swap.",
      },
      {
        q: "What is my Ferry node?",
        a: "The small program that holds your keys and does the swap for you. This app talks to it; your coins never pass through a Ferry server, because there isn't one. On the public demo a node with test coins is run for you, so you can try it without installing anything.",
      },
      {
        q: "Who is my swap partner?",
        a: (
          <>
            Someone who offers the other coin at a rate they set. Ferry picks the best rate for your amount; to choose another partner, open the settings (the gear above the swap card). A partner can't take
            your coins: the most they can do is not finish, and then your coins come back.
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
        a: "Yes. Your ZEC stays in Zcash's shielded pool the whole time, so its amount, sender and receiver are encrypted. On Bitcoin and Litecoin a finished swap looks like an ordinary payment; on Ethereum networks it is a call to the swap contract. Nothing on either chain links the two sides.",
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
        a: "Every swap has a deadline. If your partner stops before the end, the swap is called off when the deadline passes and your coins come back to your wallet automatically. Nobody can end up with both sides.",
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
            Not yet. Ferry runs on test networks today and hasn't been independently reviewed. <A to="/safety">Safety details</A> lists every known limit.
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
        a: "A few minutes on the test networks. On the main networks it follows their block times: about half an hour with Bitcoin, around 15 minutes with Litecoin, under 10 with USDC or ETH. The swap's page shows its own estimate.",
      },
      {
        q: "What does it cost?",
        landing: true,
        a: "Ferry charges nothing. Your partner's rate is the price you get, and the swap card shows exactly what you receive. On top there are the usual network fees: a small Bitcoin or Litecoin fee taken from what you get, or a little ETH for gas on Ethereum networks, and a tiny Zcash fee.",
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
        a: "Shielded ZEC for Bitcoin, Litecoin, and USDC or ETH on Base, Ethereum, Arbitrum and Optimism. Each server offers some of these; the coin list shows which ones you can pick here.",
      },
      {
        q: "Why WETH instead of ETH?",
        a: "The swap contract works with tokens, so ETH comes as WETH: ETH in token form, always worth exactly 1 ETH, which most wallets unwrap in one step. One swap can carry up to about 18.4 WETH.",
      },
      {
        q: "Can I buy ZEC instead?",
        a: "Yes. A Ferry node that holds Bitcoin, Litecoin or tokens buys shielded ZEC the same way, and its app says “Buy ZEC”.",
      },
    ],
  },
];

export const LANDING_FAQ: Faq[] = FAQ_GROUPS.flatMap((g) => g.items).filter((f) => f.landing);
