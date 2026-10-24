// Mock makers for local development, both ways round, so the maker list on /app has something to
// show in either direction:
//   B makers buy shielded ZEC (you sell it to them): served by the mock's B daemon. B's own offer
//   is at <B>/peer/offer, the others at <B>/m/<slug>/peer/offer.
//   Z makers sell shielded ZEC (you buy it from them): served by the mock's Z daemon, its own
//   offer at <Z>/peer/offer and the others at <Z>/m/<slug>/peer/offer.
// Every swap still runs between the mock's one Z party and its one B party, at the rate of the
// maker the swap was started with.
//
// `mockMakersEnv(bPort, zPort)` is the FERRY_MAKERS value that lists them (scripts/dev.mjs and the
// screenshot scripts set it for the Vite server).

export const MOCK_MAKERS = [
  // slug null: the party's own offer
  { role: "B", slug: null, name: "Bram", pair: "ZEC/BTC", rate: 410_000, min: 10_000_000, max: 1_000_000_000, source: "fixed" },
  { role: "B", slug: "kestrel", name: "Kestrel", pair: "ZEC/BTC", rate: 412_350, min: 5_000_000, max: 500_000_000, liquidity: 240_000_000, source: "median(kraken,coingecko) +50bps", ageS: 20 },
  { role: "B", slug: "heron", name: "Heron OTC", pair: "ZEC/BTC", rate: 408_900, min: 100_000_000, max: 2_500_000_000, liquidity: 2_500_000_000, source: "median(kraken,coingecko) -25bps", ageS: 47 },
  { role: "B", slug: "wren", name: "Wren", pair: "ZEC/BTC", rate: 411_200, min: 10_000_000, max: 300_000_000, liquidity: 0, source: "median(coingecko)", ageS: 340, paused: true },
  { role: "B", slug: "offline", name: "Plover", pair: "ZEC/BTC", offline: true },
  // Z makers ask a little over the market for the ZEC they sell
  { role: "Z", slug: null, name: "Zoe", pair: "ZEC/BTC", rate: 415_000, min: 10_000_000, max: 1_000_000_000, source: "fixed" },
  { role: "Z", slug: "sandpiper", name: "Sandpiper", pair: "ZEC/BTC", rate: 413_800, min: 5_000_000, max: 600_000_000, liquidity: 300_000_000, source: "median(kraken,coingecko) +40bps", ageS: 12 },
  { role: "Z", slug: "curlew", name: "Curlew", pair: "ZEC/BTC", rate: 414_400, min: 10_000_000, max: 200_000_000, liquidity: 0, source: "median(coingecko) +60bps", ageS: 410, paused: true },
];

export const mockMakerUrl = (bPort, m, zPort = bPort - 1) => `http://127.0.0.1:${m.role === "Z" ? zPort : bPort}${m.slug ? `/m/${m.slug}` : ""}`;

// `zPort` defaults to the port below B's, as in every script here
export const mockMakersEnv = (bPort, zPort = bPort - 1) => JSON.stringify(MOCK_MAKERS.map((m) => ({ name: m.name, url: mockMakerUrl(bPort, m, zPort), pair: m.pair })));

// the maker a mock party's peer path belongs to: "/peer/offer" on B → Bram, "/m/heron/peer/offer"
// on B → Heron, "/peer/offer" on Z → Zoe (`what` "quote": its /peer/quote)
export function mockMakerAt(path, role = "B", what = "offer") {
  const m = path.match(/^(?:\/m\/([a-z]+))?\/peer\/(offer|quote)$/);
  if (!m || m[2] !== what) return undefined;
  return MOCK_MAKERS.find((x) => x.role === role && x.slug === (m[1] ?? null)) ?? null;
}

// the maker behind a URL a swap was started with (the dev server resolved the name to it); a URL
// on `zPort` is one of the Z makers
export function mockMakerByUrl(url, zPort = null) {
  if (typeof url !== "string") return null;
  const slug = url.match(/\/m\/([a-z]+)\/?$/)?.[1] ?? null;
  let port = null;
  try {
    port = Number(new URL(url).port);
  } catch {
    /* not a URL */
  }
  const role = slug ? MOCK_MAKERS.find((x) => x.slug === slug)?.role : port != null && port === zPort ? "Z" : "B";
  return MOCK_MAKERS.find((x) => x.role === role && x.slug === slug) ?? null;
}
