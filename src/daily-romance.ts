import packageMetadata from "../package.json";

const HITOKOTO_API = "https://v1.hitokoto.cn/";
const HITOKOTO_SOURCE = "https://hitokoto.cn";
const HITOKOTO_MAX_LENGTH = 42;
const ZENQUOTES_API = "https://zenquotes.io/api/random";
const ZENQUOTES_SOURCE = "https://zenquotes.io/";
const ENGLISH_QUOTE_MAX_LENGTH = 96;
const ENGLISH_QUOTE_MAX_WORDS = 18;
const FAVQS_API = "https://favqs.com/api/qotd";
const FAVQS_SOURCE = "https://favqs.com/";
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT = `paper-daily-feed/${packageMetadata.version} (${packageMetadata.homepage})`;

export type DailyRomanceConfig = {
  enabled: boolean;
};

export type DailyRomance = {
  text: string;
  author: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceName: string;
};

type SourceOptions = {
  fetch?: typeof fetch;
};

type DailyRomanceOptions = SourceOptions & {
  random?: () => number;
};

function compactText(
  value: unknown,
  source: string,
  maxLength: number,
  maxWords = Number.POSITIVE_INFINITY
): string {
  if (typeof value !== "string") throw new Error(`${source} returned no quotation.`);
  const text = value.trim();
  const words = text.match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu) ?? [];
  if (
    text.length === 0 ||
    /[\r\n<>]/u.test(text) ||
    [...text].length > maxLength ||
    words.length > maxWords
  ) {
    throw new Error(`${source} returned a quotation that does not fit the email layout.`);
  }
  return text;
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function responseJson(
  url: URL | string,
  source: string,
  fetchImplementation: typeof fetch
): Promise<unknown> {
  const response = await fetchImplementation(url, {
    headers: {
      "User-Agent": USER_AGENT
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${source} returned HTTP ${response.status}.`);
  return response.json() as Promise<unknown>;
}

export async function fetchHitokotoRomance(
  options: SourceOptions = {}
): Promise<DailyRomance> {
  const url = new URL(HITOKOTO_API);
  url.search = new URLSearchParams({
    encode: "json",
    max_length: String(HITOKOTO_MAX_LENGTH)
  }).toString();
  const payload = await responseJson(url, "Hitokoto", options.fetch ?? fetch);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Hitokoto returned an invalid response.");
  }

  const data = payload as Record<string, unknown>;
  const uuid = optionalText(data.uuid);
  if (!uuid) throw new Error("Hitokoto returned no source identifier.");
  const author = optionalText(data.from_who);
  const sourceTitle = optionalText(data.from) || author || "一言";
  return {
    text: compactText(data.hitokoto, "Hitokoto", HITOKOTO_MAX_LENGTH),
    author,
    sourceTitle,
    sourceUrl: `${HITOKOTO_SOURCE}?uuid=${encodeURIComponent(uuid)}`,
    sourceName: "一言"
  };
}

export async function fetchZenQuoteRomance(
  options: SourceOptions = {}
): Promise<DailyRomance> {
  const payload = await responseJson(ZENQUOTES_API, "ZenQuotes", options.fetch ?? fetch);
  const item = Array.isArray(payload) ? payload[0] : undefined;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("ZenQuotes returned an invalid response.");
  }

  const data = item as Record<string, unknown>;
  const author = optionalText(data.a);
  if (!author) throw new Error("ZenQuotes returned no author.");
  return {
    text: compactText(
      data.q,
      "ZenQuotes",
      ENGLISH_QUOTE_MAX_LENGTH,
      ENGLISH_QUOTE_MAX_WORDS
    ),
    author,
    sourceTitle: "",
    sourceUrl: ZENQUOTES_SOURCE,
    sourceName: "ZenQuotes"
  };
}

export async function fetchFavQsRomance(
  options: SourceOptions = {}
): Promise<DailyRomance> {
  const payload = await responseJson(FAVQS_API, "FavQs", options.fetch ?? fetch);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("FavQs returned an invalid response.");
  }

  const quote = (payload as Record<string, unknown>).quote;
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
    throw new Error("FavQs returned an invalid response.");
  }

  const data = quote as Record<string, unknown>;
  const author = optionalText(data.author);
  if (!author) throw new Error("FavQs returned no author.");
  return {
    text: compactText(
      data.body,
      "FavQs",
      ENGLISH_QUOTE_MAX_LENGTH,
      ENGLISH_QUOTE_MAX_WORDS
    ),
    author,
    sourceTitle: "",
    sourceUrl: optionalText(data.url) || FAVQS_SOURCE,
    sourceName: "FavQs"
  };
}

export async function fetchDailyRomance(
  options: DailyRomanceOptions = {}
): Promise<DailyRomance | null> {
  const sourceOptions = { fetch: options.fetch };
  const random = options.random ?? Math.random;
  const preferChinese = random() < 0.5;
  const englishSources =
    random() < 0.5
      ? [fetchFavQsRomance, fetchZenQuoteRomance]
      : [fetchZenQuoteRomance, fetchFavQsRomance];
  const sources = preferChinese
    ? [fetchHitokotoRomance, ...englishSources]
    : [...englishSources, fetchHitokotoRomance];

  for (const source of sources) {
    try {
      const romance = await source(sourceOptions);
      console.info(`Fetched daily romance from ${romance.sourceName}.`);
      return romance;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Daily romance source skipped: ${message}`);
    }
  }
  return null;
}
