import { describe, expect, it, spyOn } from "bun:test";
import packageMetadata from "../package.json";
import {
  fetchDailyRomance,
  fetchFavQsRomance,
  fetchHitokotoRomance,
  fetchZenQuoteRomance
} from "../src/daily-romance.js";

describe("daily romance sources", () => {
  it("requests an unfiltered, email-sized sentence from Hitokoto", async () => {
    let requestedUrl = "";
    const romance = await fetchHitokotoRomance({
      fetch: (async (input) => {
        requestedUrl = String(input);
        return Response.json({
          hitokoto: "空山新雨后，天气晚来秋。",
          from: "山居秋暝",
          from_who: "王维",
          uuid: "78c500e3-40ae-4d89-93ab-c1f8c8deb88e"
        });
      }) as typeof fetch
    });

    const url = new URL(requestedUrl);
    expect(url.origin).toBe("https://v1.hitokoto.cn");
    expect(url.searchParams.get("encode")).toBe("json");
    expect(url.searchParams.get("max_length")).toBe("42");
    expect([...url.searchParams.keys()].sort()).toEqual(["encode", "max_length"]);
    expect(romance).toEqual({
      text: "空山新雨后，天气晚来秋。",
      author: "王维",
      sourceTitle: "山居秋暝",
      sourceUrl:
        "https://hitokoto.cn?uuid=78c500e3-40ae-4d89-93ab-c1f8c8deb88e",
      sourceName: "一言"
    });
  });

  it("accepts a compact English quotation from ZenQuotes", async () => {
    const romance = await fetchZenQuoteRomance({
      fetch: (async (input, init) => {
        expect(String(input)).toBe("https://zenquotes.io/api/random");
        expect(init?.headers).toEqual({
          "User-Agent": `paper-daily-feed/${packageMetadata.version} (${packageMetadata.homepage})`
        });
        return Response.json([
          {
            q: "The quieter you become, the more you are able to hear.",
            a: "Rumi"
          }
        ]);
      }) as typeof fetch
    });

    expect(romance).toEqual({
      text: "The quieter you become, the more you are able to hear.",
      author: "Rumi",
      sourceTitle: "",
      sourceUrl: "https://zenquotes.io/",
      sourceName: "ZenQuotes"
    });
  });

  it("accepts a compact English quotation from FavQs", async () => {
    const romance = await fetchFavQsRomance({
      fetch: (async (input, init) => {
        expect(String(input)).toBe("https://favqs.com/api/qotd");
        expect(init?.headers).toEqual({
          "User-Agent": `paper-daily-feed/${packageMetadata.version} (${packageMetadata.homepage})`
        });
        return Response.json({
          quote: {
            body: "Success is never final, failure is never fatal.",
            author: "John Wooden",
            url: "https://favqs.com/quotes/john-wooden/11857-success-is-ne-"
          }
        });
      }) as typeof fetch
    });

    expect(romance).toEqual({
      text: "Success is never final, failure is never fatal.",
      author: "John Wooden",
      sourceTitle: "",
      sourceUrl: "https://favqs.com/quotes/john-wooden/11857-success-is-ne-",
      sourceName: "FavQs"
    });
  });

  it("rejects ZenQuotes text that would crowd the email header", async () => {
    await expect(
      fetchZenQuoteRomance({
        fetch: (async () =>
          Response.json([
            {
              q: "This quotation is deliberately much too long for the compact email layout because it keeps adding unnecessary clauses and explanations until the daily moment of beauty has turned into a paragraph that overwhelms the research recommendations below it.",
              a: "Example Author"
            }
          ])) as unknown as typeof fetch
      })
    ).rejects.toThrow("email layout");
  });

  it("caps English quotations at 96 characters and 18 words", async () => {
    const fetchQuote = (quote: string) =>
      fetchZenQuoteRomance({
        fetch: (async () =>
          Response.json([{ q: quote, a: "Example Author" }])) as unknown as typeof fetch
      });

    await expect(fetchQuote("A".repeat(97))).rejects.toThrow("email layout");
    await expect(
      fetchQuote(
        "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen."
      )
    ).rejects.toThrow("email layout");
  });

  it("falls back to the other English source before changing language", async () => {
    const calls: string[] = [];
    const infoSpy = spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const fetchImplementation = (async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("zenquotes")) return new Response("unavailable", { status: 503 });
        if (url.includes("favqs")) {
          return Response.json({
            quote: {
              body: "Success is never final, failure is never fatal.",
              author: "John Wooden",
              url: "https://favqs.com/quotes/john-wooden/11857-success-is-ne-"
            }
          });
        }
        return Response.json({
          hitokoto: "今晚的月色真美。",
          from: "网络",
          from_who: null,
          uuid: "fallback-id"
        });
      }) as typeof fetch;

      const romance = await fetchDailyRomance({
        fetch: fetchImplementation,
        random: () => 0.75
      });

      expect(calls).toEqual([
        "https://zenquotes.io/api/random",
        "https://favqs.com/api/qotd"
      ]);
      expect(romance?.text).toBe("Success is never final, failure is never fatal.");
      expect(infoSpy).toHaveBeenCalledWith("Fetched daily romance from FavQs.");
    } finally {
      infoSpy.mockRestore();
    }
  });
});
