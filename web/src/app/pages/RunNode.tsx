import { Fragment, useEffect, useState, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, ArrowsLeftRight, Check, CheckCircle, Coins, Copy, Desktop, Lifebuoy, PaperPlaneTilt, Terminal, Wrench } from "@phosphor-icons/react";
import { Link } from "@/router";
import { Label, Layout, REPO_URL } from "../components/Layout";
import { ChainLogo, TokenLogo, type TokenId } from "../components/Logos";
import { StatusBadge } from "../components/ui/badge";
import { Card, CardContent } from "../components/ui/card";
import { useLocal } from "../lib/daemon";
import { Box, Section } from "./HowItWorks";

// /run-a-node: running Ferry on your own computer, for anyone who found the public demo and wants
// to swap with their own keys: what you need, the one command, test coins, a first swap, getting
// coins out, and the node's other commands. docs/RUN-A-NODE.md is the full guide (mainnet, restore,
// makers); this page follows it. Same Docs layout as /how-it-works.

const sections = [
  { id: "need", label: "What you need" },
  { id: "start", label: "What it does" },
  { id: "fund", label: "Add test coins" },
  { id: "swap", label: "Make a swap" },
  { id: "out", label: "Get your coins out" },
  { id: "care", label: "Look after it" },
  { id: "trouble", label: "If something goes wrong" },
];

const START = [`git clone ${REPO_URL}.git`, "cd ferry", "./infra/node/ferry up"];
const GUIDE = `${REPO_URL}/blob/master/docs/RUN-A-NODE.md`;
const APP = "http://127.0.0.1:7865";

// the faucets `./infra/node/ferry addresses` names (infra/node/report.mjs)
const FAUCET = {
  taz: "https://fauzec.com",
  usdc: "https://faucet.circle.com",
  coinbase: "https://portal.cdp.coinbase.com/products/faucet",
  alchemy: "https://www.alchemy.com/faucets/base-sepolia",
  signet: "https://signetfaucet.com",
};

function useActive() {
  const [active, setActive] = useState(sections[0].id);
  useEffect(() => {
    const on = () => {
      let cur = sections[0].id;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top - 140 <= 0) cur = s.id;
      }
      setActive(cur);
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return active;
}

export function RunNode() {
  const active = useActive();
  const own = useLocal().info.own;
  return (
    <Layout>
      <div className="space-y-8">
        <div className="space-y-4">
          <p className="font-mono text-xs tracking-widest text-slate-600">GUIDE</p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Run your own Ferry node</h1>
          <p className="max-w-3xl text-slate-600">
            The public demo runs a node for you with our test coins, so you can try a swap without installing anything. To swap with your own keys and coins, run one on your
            computer: one command starts the same app with wallets of your own, on public test networks, with free test coins.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <StatusBadge variant="outline" className="border-slate-200 bg-slate-50 text-slate-700">
              <Terminal size={10} weight="fill" />
              One command
            </StatusBadge>
            <StatusBadge variant="outline">Test networks</StatusBadge>
            <StatusBadge variant="outline">macOS · Linux · Windows</StatusBadge>
          </div>
          {own ? <OwnNote /> : null}
          <div className="max-w-2xl space-y-2 pt-2">
            <Command lines={START} />
            <p className="text-sm text-slate-500">Needs Docker. The first start builds Ferry, which takes 15 to 40 minutes; after that it starts in seconds.</p>
          </div>
        </div>

        <div className="lg:grid lg:grid-cols-[220px_1fr] lg:items-start lg:gap-12">
          <aside className="hidden self-start lg:sticky lg:top-24 lg:block">
            <Label className="mb-3">Contents</Label>
            <nav className="flex flex-col border-l border-slate-200">
              {sections.map((s, i) => {
                const on = active === s.id;
                return (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
                    className={`-ml-px flex items-center gap-3 border-l-2 py-2 pl-3 text-sm transition-colors ${on ? "border-slate-900 font-semibold text-slate-600" : "border-transparent text-slate-600 hover:text-slate-900"}`}
                  >
                    <span className={`font-mono text-[10px] tracking-widest ${on ? "text-slate-900" : "text-slate-400"}`}>{String(i + 1).padStart(2, "0")}</span>
                    <span>{s.label}</span>
                  </a>
                );
              })}
            </nav>
          </aside>

          <div className="min-w-0 space-y-12">
            <Section id="need" n="01" eyebrow="What you need" icon={<Desktop size={18} weight="duotone" className="text-slate-900" />} title="A computer with Docker">
              <p>A node runs on macOS, Linux or Windows. Phones and tablets can't run one; the public demo works on them for a look around.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Box label="Docker">
                  <p className="text-slate-600">Docker Desktop on macOS or Windows (on Windows, through WSL2), or Docker Engine with the Compose plugin on Linux. Compose 2.20 or newer.</p>
                </Box>
                <Box label="git, curl and openssl">
                  <p className="text-slate-600">Already there on macOS and most Linux systems.</p>
                </Box>
                <Box label="Disk">
                  <p className="text-slate-600">About 20 GB free for Docker the first time, while Ferry builds from source; about 1 GB once it's built. A Bitcoin or Litecoin node takes about 5 GB more.</p>
                </Box>
                <Box label="Time">
                  <p className="text-slate-600">The first start builds Ferry: 15 to 40 minutes. After that it starts in seconds.</p>
                </Box>
              </div>
            </Section>

            <Section id="start" n="02" eyebrow="What it does" icon={<Terminal size={18} weight="duotone" className="text-slate-900" />} title="Two questions, then your node starts">
              <p>Run the command above in a terminal. The first time, it asks two things and remembers the answers:</p>
              <Steps
                items={[
                  [
                    "Which pairs",
                    "ZEC ⇄ USDC on Base Sepolia is on by default: it has no chain to sync and works a minute after start. ZEC ⇄ WETH is the same kind. ZEC ⇄ BTC on Bitcoin signet and ZEC ⇄ LTC on Litecoin testnet each run a pruned chain node that syncs for an hour or more in the background.",
                  ],
                  ["Which Base Sepolia RPC", "Press Enter for the public one: shared and rate limited, but fine to start. Or paste your own from Alchemy, Infura, QuickNode or Coinbase."],
                ]}
              />
              <p>
                Add <Code>--yes</Code> to skip both and take the defaults. Then it checks Docker, the port and the disk, makes your wallets (the keys are made on your computer, kept
                only in its <Code>.ferry-node</Code> folder and never printed), builds Ferry the first time, starts everything and opens the app.
              </p>
              <TerminalOutput />
              <Note>
                Use exactly <Code>{APP}</Code> in the browser: your node takes actions only from that address. Running <Code>up</Code> again is safe: it changes nothing that's already
                right.
              </Note>
            </Section>

            <Section id="fund" n="03" eyebrow="Add test coins" icon={<Coins size={18} weight="duotone" className="text-slate-900" />} title="Free coins from faucets">
              <p>
                Test coins have no value, and faucets give them away. In the app, open <b className="font-semibold text-slate-900">Wallet</b> from the menu at the top right and press{" "}
                <b className="font-semibold text-slate-900">Add funds</b> on each coin: it shows your node's address, a QR code and the network to send on. In the terminal,{" "}
                <Code>./infra/node/ferry addresses</Code> lists the same.
              </p>
              <p>Enough for a first swap, selling 0.1 ZEC for USDC:</p>
              <FundList />
              <ul className="list-disc space-y-1.5 pl-5 marker:text-slate-400">
                <li>
                  <b className="font-semibold text-slate-900">Base Sepolia, not Ethereum Sepolia.</b> Pick Base Sepolia on each faucet; coins sent on Ethereum Sepolia don't arrive.
                </li>
                <li>Test ZEC is ready to swap after 10 confirmations, about 13 minutes.</li>
                <li>Your node keeps a wallet for each way it swaps, and each pays its own gas. Add funds puts ZEC on the selling side and USDC on the buying side; for ETH, you pick the side.</li>
                <li>
                  Running the Bitcoin pair? Signet coins come from <Ext href={FAUCET.signet}>signetfaucet.com</Ext>.
                </li>
              </ul>
            </Section>

            <Section id="swap" n="04" eyebrow="Make a swap" icon={<ArrowsLeftRight size={18} weight="duotone" className="text-slate-900" />} title="Sell 0.1 ZEC and watch it settle">
              <Steps
                items={[
                  ["Open Swap", "Type 0.1 in the ZEC box, pick USDC, and press Sell ZEC."],
                  [
                    "Let it run",
                    "Both sides lock their coins, then your node claims the USDC. The swap's page shows each step. With USDC on Base Sepolia it takes about 2 to 10 minutes, mostly waiting for Zcash; with Bitcoin on signet, 20 to 40.",
                  ],
                  [
                    "Keep the computer on",
                    "You can close the browser: your node finishes the swap. Keep the computer on and online until it's done. If it was off past a deadline, start the node again: it picks up where it was and refunds what it can.",
                  ],
                  ["Done", "The USDC is in your node's wallet. To buy ZEC instead, press the arrow between the two boxes first."],
                ]}
              />
              <Note label="Who's on the other side?">
                Until other people's nodes are listed as partners, your node trades between its own two wallets of each pair. That still runs the whole swap on real test networks:
                both chains, both locks, the claim.
              </Note>
            </Section>

            <Section id="out" n="05" eyebrow="Get your coins out" icon={<PaperPlaneTilt size={18} weight="duotone" className="text-slate-900" />} title="Send them to your own wallet">
              <p>Your node's wallets are for swapping, not for keeping savings. Two ways out:</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Box label="Send to my wallet">
                  <p className="text-slate-600">On the Wallet page: pick a coin, type an amount and your address, check the network fee, and send.</p>
                </Box>
                <Box label="Receive to">
                  <p className="text-slate-600">On the swap card: the swap pays straight to an address of yours, such as Zodl for the ZEC you buy, still shielded.</p>
                </Box>
              </div>
            </Section>

            <Section id="care" n="06" eyebrow="Look after it" icon={<Wrench size={18} weight="duotone" className="text-slate-900" />} title="Back up, check, update, stop">
              <ul className="divide-y divide-slate-100 rounded border border-slate-200 bg-white">
                {CARE.map(([cmd, what]) => (
                  <CommandRow key={cmd} cmd={`./infra/node/ferry ${cmd}`}>
                    {what}
                  </CommandRow>
                ))}
              </ul>
            </Section>

            <Section id="trouble" n="07" eyebrow="If something goes wrong" icon={<Lifebuoy size={18} weight="duotone" className="text-slate-900" />} title="What it says, and what to do">
              <dl className="divide-y divide-slate-100 rounded border border-slate-200 bg-white">
                {TROUBLE.map(([says, fix]) => (
                  <div key={says} className="grid gap-1 p-4 md:grid-cols-[260px_1fr] md:gap-6">
                    <dt className="font-medium text-slate-900">{says}</dt>
                    <dd className="text-slate-600">{fix}</dd>
                  </div>
                ))}
              </dl>
            </Section>

            <Card>
              <CardContent className="space-y-4 py-8 text-center">
                <p className="text-lg font-semibold text-slate-900">That's all it takes.</p>
                <p className="mx-auto max-w-xl text-sm text-slate-600">
                  Mainnet with real money (every swap capped at 0.02 ZEC; Ferry is unaudited), restoring a backup and adding partners are in the full guide.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <a
                    href={GUIDE}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-8 py-3 font-semibold text-white transition-colors hover:bg-slate-800"
                  >
                    Read the full guide
                    <ArrowUpRight size={14} weight="bold" aria-hidden />
                  </a>
                  <Link
                    to="/app"
                    className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-6 py-3 font-semibold text-slate-900 transition-colors hover:border-slate-300 hover:bg-slate-50"
                  >
                    Start a swap
                    <ArrowRight size={14} weight="bold" aria-hidden />
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </Layout>
  );
}

function OwnNote() {
  return (
    <div className="flex max-w-3xl items-start gap-3 rounded border border-slate-200 bg-slate-50 px-4 py-3.5 text-sm text-slate-700" data-own-note>
      <CheckCircle size={18} weight="fill" className="mt-px shrink-0 text-slate-900" aria-hidden />
      <p>
        This is your own Ferry node: the command below has done its work. Next, add test coins on the{" "}
        <Link to="/wallet" className="font-medium text-slate-900 underline underline-offset-4">
          Wallet
        </Link>{" "}
        page, then make a swap.
      </p>
    </div>
  );
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="box-decoration-clone rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[12px] text-slate-900">{children}</code>
);

const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="inline-flex items-center gap-0.5 font-medium text-slate-900 underline decoration-slate-300 underline-offset-4 transition-colors hover:decoration-slate-900"
  >
    {children}
    <ArrowUpRight size={11} weight="bold" aria-hidden />
  </a>
);

function Note({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5 rounded border border-slate-200 bg-slate-50 p-4">
      {label ? <Label>{label}</Label> : null}
      <p className="text-slate-700">{children}</p>
    </div>
  );
}

function Steps({ items }: { items: [string, string][] }) {
  return (
    <ol className="space-y-2">
      {items.map(([t, d], k) => (
        <li key={t} className="flex gap-4 rounded border border-slate-200 bg-white p-4">
          <span className="shrink-0 pt-0.5 font-mono text-xs tracking-widest text-slate-500">{String(k + 1).padStart(2, "0")}</span>
          <div className="space-y-1">
            <p className="font-semibold text-slate-900">{t}</p>
            <p className="text-slate-600">{d}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  return [copied, copy] as const;
}

// a command to paste into a terminal: a step a line on screen, one line when copied. A line too
// long for a phone wraps after a "/" (the repo's URL), not inside a word.
function Command({ lines }: { lines: string[] }) {
  const [copied, copy] = useCopy(lines.join(" && "));
  return (
    <div className="relative rounded-lg bg-slate-900 py-3.5 pr-14 pl-4 font-mono text-[13px] leading-6 text-slate-100" data-command>
      {lines.map((l) => (
        <p key={l} className="break-words">
          <span className="text-slate-500 select-none" aria-hidden>
            ${" "}
          </span>
          {l.split("/").map((part, i, all) => (
            <Fragment key={i}>
              {part}
              {i < all.length - 1 ? (
                <>
                  /<wbr />
                </>
              ) : null}
            </Fragment>
          ))}
        </p>
      ))}
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy the command"}
        title="Copy the command"
        className="absolute top-2 right-2 inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
      >
        {copied ? <Check size={16} weight="bold" className="text-emerald-400" aria-hidden /> : <Copy size={16} weight="bold" aria-hidden />}
      </button>
    </div>
  );
}

// what `up` prints the first time, shortened (infra/node/ferry's own lines)
const OUTPUT: ["step" | "ok" | "done" | "", string][] = [
  ["step", "Ferry node on test networks"],
  ["", "  ZEC <-> USDC on Base Sepolia"],
  ["step", "Building the Ferry daemon (ferryd) (15-40 minutes the first time)"],
  ["ok", "the Ferry daemon (ferryd) built in 21 min"],
  ["step", "Starting"],
  ["step", "Waiting for your node to come up"],
  ["ok", `web app on ${APP}`],
  ["ok", "ZEC <-> USDC on Base Sepolia: both daemons answer"],
  ["", ""],
  ["done", `Your Ferry node is running: ${APP}`],
  ["", ""],
  ["", "  Fund your wallets:  ./infra/node/ferry addresses"],
  ["", "  Back them up:       ./infra/node/ferry backup"],
  ["", "  See how it's doing: ./infra/node/ferry status"],
  ["", "  Stop it:            ./infra/node/ferry down"],
];

function TerminalOutput() {
  return (
    <figure className="overflow-hidden rounded-lg bg-slate-900">
      <figcaption className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-2.5 w-2.5 rounded-full bg-white/20" />
          ))}
        </span>
        <span className="ml-1 font-mono text-[10px] tracking-widest text-slate-400 uppercase">What you'll see</span>
      </figcaption>
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-[1.7] text-slate-300">
        {OUTPUT.map(([kind, text], i) => (
          <div key={i}>
            {kind === "step" ? (
              <>
                <span className="font-semibold text-white">==&gt;</span> {text}
              </>
            ) : kind === "ok" ? (
              <>
                {"  "}
                <span className="text-emerald-400">ok</span>
                {"  "}
                {text}
              </>
            ) : kind === "done" ? (
              <span className="font-semibold text-white">{text}</span>
            ) : (
              text || " "
            )}
          </div>
        ))}
      </pre>
    </figure>
  );
}

// enough for a first swap on the USDC pair: `addresses` suggests these amounts (infra/node/report.mjs)
const FUND: { id: TokenId; coin: string; net: string; amount: string; note?: string; from: [string, string][] }[] = [
  { id: "zec", coin: "Test ZEC", net: "Zcash testnet", amount: "0.3 TAZ", from: [["fauzec.com", FAUCET.taz]] },
  { id: "usdc", coin: "USDC", net: "Base Sepolia", amount: "10 USDC", from: [["faucet.circle.com", FAUCET.usdc]] },
  {
    id: "eth",
    coin: "ETH, for gas",
    net: "Base Sepolia",
    amount: "0.003 ETH",
    note: "0.002 to the buying side, 0.001 to the selling side",
    from: [
      ["Coinbase", FAUCET.coinbase],
      ["Alchemy", FAUCET.alchemy],
    ],
  },
];

function FundList() {
  return (
    <ul className="divide-y divide-slate-100 rounded border border-slate-200 bg-white">
      {FUND.map((f) => (
        <li key={f.id} className="flex items-start gap-3 p-4" data-fund={f.id}>
          <span className="relative mt-0.5 inline-flex shrink-0">
            <TokenLogo id={f.id} size={32} />
            {f.net === "Base Sepolia" ? (
              <span className="absolute -right-1 -bottom-1 inline-flex rounded-full bg-white p-[1.5px]" aria-hidden>
                <ChainLogo id="base" size={14} />
              </span>
            ) : null}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-medium text-slate-900">{f.coin}</p>
              <p className="shrink-0 font-medium text-slate-900 tabular-nums">{f.amount}</p>
            </div>
            <p className="text-slate-500">
              {f.net}
              {f.note ? ` · ${f.note}` : ""}
            </p>
            <p className="mt-1 text-slate-600">
              Free from{" "}
              {f.from.map(([name, href], i) => (
                <span key={href}>
                  {i ? " or " : ""}
                  <Ext href={href}>{name}</Ext>
                </span>
              ))}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

const CARE: [string, ReactNode][] = [
  [
    "backup",
    <>
      An encrypted file with every key and wallet of your node, under a passphrase you choose. Your keys exist only in the <Code>.ferry-node</Code> folder: if it's lost without a
      backup, so are the coins.
    </>,
  ],
  ["status", "What runs, the chain sync, balances and swaps in progress, with a plain reason when something keeps failing."],
  ["logs", "Follows the logs. Ctrl-C stops following, not the node."],
  ["update", "Gets the latest Ferry, rebuilds what changed and restarts. Your wallets and settings stay."],
  [
    "down",
    <>
      Stops everything; your wallets and keys stay, and <Code>up</Code> starts it again in seconds. Avoid it during a swap: the swap resumes on the next <Code>up</Code>, but a deadline
      can pass while it's off.
    </>,
  ],
];

function CommandRow({ cmd, children }: { cmd: string; children: ReactNode }) {
  const [copied, copy] = useCopy(cmd);
  return (
    <li className="grid gap-1.5 p-4 md:grid-cols-[260px_1fr] md:gap-6">
      <button type="button" onClick={copy} aria-label={`Copy ${cmd}`} className="group inline-flex w-fit items-center gap-2 self-start rounded text-left font-mono text-[13px] text-slate-900">
        {cmd}
        {copied ? (
          <Check size={12} weight="bold" className="shrink-0 text-emerald-600" aria-hidden />
        ) : (
          <Copy size={12} weight="bold" className="shrink-0 opacity-40 transition-opacity group-hover:opacity-100" aria-hidden />
        )}
      </button>
      <p className="text-slate-600">{children}</p>
    </li>
  );
}

const TROUBLE: [string, ReactNode][] = [
  [
    "Docker is not installed, or not running",
    <>
      Install or start Docker Desktop. On Linux: <Code>sudo systemctl start docker</Code>.
    </>,
  ],
  [
    "Port 7865 is already in use",
    <>
      Stop the other program, or use another port: <Code>./infra/node/ferry up --port 7875</Code>.
    </>,
  ],
  [
    "Not enough disk space for Docker",
    <>
      Free some space: <Code>docker system prune</Code> removes unused images and build cache. Or give Docker Desktop a bigger disk in Settings, Resources.
    </>,
  ],
  [
    "The RPC is rate limiting your node",
    <>
      Run <Code>./infra/node/ferry setup</Code> and paste your own Base Sepolia RPC URL.
    </>,
  ],
  ["It can't reach the Zcash server", "Check the internet connection; it retries by itself."],
  [
    "Bitcoin signet node: SYNCING",
    <>
      Wait: <Code>./infra/node/ferry status</Code> shows the progress. ZEC ⇄ BTC works once it's synced.
    </>,
  ],
  [
    "A swap shows an error in the app",
    <>
      <Code>./infra/node/ferry logs</Code> shows why. Your node retries, and if the swap is called off, the deadlines return your coins.
    </>,
  ],
];
