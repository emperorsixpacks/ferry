// Mock makers for local development: several offers served by the mock's B daemon, so the maker
// list on /app has something to show. B's own offer is at <B>/peer/offer; the others are at
// <B>/m/<slug>/peer/offer. Every swap still runs against the mock's one B party, at the rate of the
// maker the swap was started with.
//
// `mockMakersEnv(bPort)` is the FERRY_MAKERS value that lists them (scripts/dev.mjs and the
// screenshot scripts set it for the Vite server).

export const MOCK_MAKERS = [
  // slug null: B's own offer
  { slug: null, name: "Bram", pair: "ZEC/BTC", rate: 410_000, min: 10_000_000, max: 1_000_000_000, source: "fixed" },
  { slug: "kestrel", name: "Kestrel", pair: "ZEC/BTC", rate: 412_350, min: 5_000_000, max: 500_000_000, liquidity: 240_000_000, source: "median(kraken,coingecko) +50bps", ageS: 20 },
  { slug: "heron", name: "Heron OTC", pair: "ZEC/BTC", rate: 408_900, min: 100_000_000, max: 2_500_000_000, liquidity: 2_500_000_000, source: "median(kraken,coingecko) -25bps", ageS: 47 },
  { slug: "wren", name: "Wren", pair: "ZEC/BTC", rate: 411_200, min: 10_000_000, max: 300_000_000, liquidity: 0, source: "median(coingecko)", ageS: 340, paused: true },
  { slug: "offline", name: "Plover", pair: "ZEC/BTC", offline: true },
];

export const mockMakerUrl = (bPort, m) => `http://127.0.0.1:${bPort}${m.slug ? `/m/${m.slug}` : ""}`;

export const mockMakersEnv = (bPort) => JSON.stringify(MOCK_MAKERS.map((m) => ({ name: m.name, url: mockMakerUrl(bPort, m), pair: m.pair })));

// the maker a mock peer path belongs to: "/peer/offer" → Bram, "/m/heron/peer/offer" → Heron
export function mockMakerAt(path) {
  const m = path.match(/^(?:\/m\/([a-z]+))?\/peer\/offer$/);
  if (!m) return undefined;
  return MOCK_MAKERS.find((x) => x.slug === (m[1] ?? null)) ?? null;
}

// the maker behind a URL a swap was started with (the dev server resolved the name to it)
export function mockMakerByUrl(url) {
  if (typeof url !== "string") return null;
  const slug = url.match(/\/m\/([a-z]+)\/?$/)?.[1] ?? null;
  return MOCK_MAKERS.find((x) => x.slug === slug) ?? null;
}
