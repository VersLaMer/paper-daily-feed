import { afterEach, describe, expect, it, mock } from "bun:test";
import { createOpenAIEditorialSummarizer } from "../src/summary.js";
import type { SummaryConfig } from "../src/app-config.js";
import type { RecommendedPaper } from "../src/types.js";
import { stubFetch } from "./test-support.js";

const summaryConfig: SummaryConfig = {
  enabled: true,
  baseUrl: "https://example.test/v1",
  model: "Qwen/Qwen3-8B",
  apiKey: "llm-key",
  language: "Chinese",
  maxTokens: 2048
};

const papers: RecommendedPaper[] = [
  {
    journal: "Nature Cities",
    title: "Urban mobility",
    abstract: "A paper about network structure and equitable urban mobility.",
    url: "https://example.test/paper",
    publishedAt: null,
    score: 0.9,
    matchContext: {
      bestMatchSource: "profile",
      bestMatchTitle: "Transport equity",
      bestMatchTopics: ["transport"]
    }
  }
];

const responseDigest = {
  headline: "空间结构进入城市预测核心",
  overview: "网络结构正成为改善城市出行预测的核心信息。",
  preheader: "首选论文将网络拓扑直接纳入预测。",
  papers: [
    {
      tldr: "该研究联合建模连续空间与交通网络以预测城市出行。"
    }
  ]
};

describe("createOpenAIEditorialSummarizer", () => {
  afterEach(() => {
    mock.restore();
  });

  it("generates one Today Brief from the complete set and one TLDR per paper", async () => {
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const requestBody = String(init?.body);
      const content = requestBody.includes("Generate the Today Brief from all supplied papers")
        ? {
            headline: responseDigest.headline,
            overview: responseDigest.overview,
            preheader: responseDigest.preheader
          }
        : responseDigest.papers[0]!.tldr;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    stubFetch(fetchMock);

    const summarize = createOpenAIEditorialSummarizer(summaryConfig);
    const result = await summarize(papers, "Urban mobility and transport equity.");

    expect(result).toEqual({
      todayBrief: {
        headline: responseDigest.headline,
        overview: responseDigest.overview,
        preheader: responseDigest.preheader
      },
      papers: responseDigest.papers
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/v1/chat/completions",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ Authorization: "Bearer llm-key" }),
        body: expect.stringContaining('"model":"Qwen/Qwen3-8B"')
      })
    );
    const requestBodies = fetchMock.mock.calls.map((call) => String(call[1]?.body));
    const todayBriefRequest = requestBodies.find((body) => body.includes("Generate the Today Brief"));
    const paperRequest = requestBodies.find((body) =>
      body.includes("You write concise one-sentence TLDR summaries for academic papers")
    );
    expect(todayBriefRequest).toContain("Chinese");
    expect(todayBriefRequest).toContain("Urban mobility and transport equity.");
    expect(todayBriefRequest).toContain("network structure and equitable urban mobility");
    expect(todayBriefRequest).toContain("does not need to represent every supplied paper");
    expect(paperRequest).toContain("Chinese");
    expect(paperRequest).toContain("network structure and equitable urban mobility");
    expect(paperRequest).not.toContain("Urban mobility and transport equity.");
    expect(paperRequest).toContain("Return only the TLDR as plain text");
    expect(paperRequest).toContain("do not infer missing information");
    expect(paperRequest).not.toContain("careful editor");
    expect(requestBodies.every((body) => body.includes('"max_tokens":2048'))).toBeTrue();
  });

  it("generates paper TLDRs concurrently with a bounded request count", async () => {
    const manyPapers = Array.from({ length: 6 }, (_, index) => ({
      ...papers[0]!,
      title: `Paper ${index}`,
      url: `https://example.test/paper-${index}`
    }));
    let releasePaperRequests: (() => void) | undefined;
    const paperRequestGate = new Promise<void>((resolve) => {
      releasePaperRequests = resolve;
    });
    let activePaperRequests = 0;
    let maxActivePaperRequests = 0;
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const requestBody = String(init?.body);
      if (requestBody.includes("Generate the Today Brief")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    headline: responseDigest.headline,
                    overview: responseDigest.overview,
                    preheader: responseDigest.preheader
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      activePaperRequests += 1;
      maxActivePaperRequests = Math.max(maxActivePaperRequests, activePaperRequests);
      await paperRequestGate;
      activePaperRequests -= 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(responseDigest.papers[0]) } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    stubFetch(fetchMock);

    const resultPromise = createOpenAIEditorialSummarizer(summaryConfig)(manyPapers, "Urban mobility");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxActivePaperRequests).toBeGreaterThan(1);
    expect(maxActivePaperRequests).toBeLessThanOrEqual(4);
    releasePaperRequests?.();
    const result = await resultPromise;
    expect(result.papers).toHaveLength(manyPapers.length);
  });

  it("keeps the Today Brief and successful TLDRs when one paper summary fails", async () => {
    const selectedPapers = [
      { ...papers[0]!, title: "Unavailable summary", abstract: "Source abstract for fallback." },
      { ...papers[0]!, title: "Successful summary", url: "https://example.test/success" }
    ];
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const requestBody = String(init?.body);
        if (requestBody.includes("Generate the Today Brief")) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      headline: responseDigest.headline,
                      overview: responseDigest.overview,
                      preheader: responseDigest.preheader
                    })
                  }
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (requestBody.includes("Title: Unavailable summary")) {
          return new Response("unavailable", { status: 503 });
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(responseDigest.papers[0]) } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(selectedPapers, "Urban mobility");

    expect(result.todayBrief?.headline).toBe(responseDigest.headline);
    expect(result.papers[0]).toEqual({
      tldr: "TLDR 暂时生成失败。",
      unavailable: true
    });
    expect(result.papers[1]).toEqual(responseDigest.papers[0]);
  });

  it("marks missing abstracts as title-only and requests a Chinese title translation", async () => {
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const requestBody = String(init?.body);
      const content = requestBody.includes("Generate the Today Brief")
        ? {
            headline: responseDigest.headline,
            overview: responseDigest.overview,
            preheader: responseDigest.preheader
          }
        : "基于大型语言模型对复杂相对位置描述进行地理编码。";
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    stubFetch(fetchMock);

    const titleOnlyPaper = {
      ...papers[0]!,
      title: "Georeferencing complex relative locality descriptions with large language models",
      abstract: "."
    };
    const result = await createOpenAIEditorialSummarizer(summaryConfig)([titleOnlyPaper], "Urban mobility");
    const requestBody = fetchMock.mock.calls
      .map((call) => String(call[1]?.body))
      .find((body) =>
        body.includes("You write concise one-sentence TLDR summaries for academic papers")
      );

    expect(result.papers[0]).toEqual({
      tldr: "基于大型语言模型对复杂相对位置描述进行地理编码。",
      titleOnly: true
    });
    expect(requestBody).toContain("Source material: Title only (abstract unavailable)");
    expect(requestBody).toContain("Write the TLDR in Chinese");
    expect(requestBody).toContain("do not infer missing information");
    expect(requestBody).not.toContain("Abstract: .");
  });

  it("requests a concise title summary when an English paper has no abstract", async () => {
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const requestBody = String(init?.body);
      const content = requestBody.includes("Generate the Today Brief")
        ? {
            headline: "Large language models support locality georeferencing",
            overview: "The work concerns georeferencing relative locality descriptions.",
            preheader: "Georeferencing relative locality descriptions."
          }
        : "Using large language models to georeference complex relative locality descriptions.";
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    stubFetch(fetchMock);

    const result = await createOpenAIEditorialSummarizer({ ...summaryConfig, language: "English" })(
      [{ ...papers[0]!, abstract: "" }],
      "Urban mobility"
    );
    const requestBody = fetchMock.mock.calls
      .map((call) => String(call[1]?.body))
      .find((body) =>
        body.includes("You write concise one-sentence TLDR summaries for academic papers")
      );

    expect(result.papers[0]?.titleOnly).toBeTrue();
    expect(requestBody).toContain("Write the TLDR in English");
    expect(requestBody).toContain("do not infer missing information");
  });

  it("retries a title-only TLDR that merely repeats the source title", async () => {
    let paperRequestCount = 0;
    const titleOnlyPaper = { ...papers[0]!, abstract: "" };
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const requestBody = String(init?.body);
      const content = requestBody.includes("Generate the Today Brief")
        ? {
            headline: responseDigest.headline,
            overview: responseDigest.overview,
            preheader: responseDigest.preheader
          }
        : ++paperRequestCount === 1
          ? titleOnlyPaper.title
          : "这篇论文聚焦城市移动性。";
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    stubFetch(fetchMock);

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(
      [titleOnlyPaper],
      "Urban mobility"
    );

    expect(paperRequestCount).toBe(2);
    expect(result.papers[0]).toEqual({
      tldr: "这篇论文聚焦城市移动性。",
      titleOnly: true
    });
    expect(String(fetchMock.mock.calls[2]?.[1]?.body)).toContain("Do not copy the source title verbatim");
  });

  it("accepts JSON wrapped in a markdown code fence", async () => {
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const requestBody = String(init?.body);
        const content = requestBody.includes("Generate the Today Brief")
          ? {
              headline: responseDigest.headline,
              overview: responseDigest.overview,
              preheader: responseDigest.preheader
            }
          : responseDigest.papers[0];
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(content)}\n\`\`\`` } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, "Urban mobility");
    expect(result.todayBrief?.headline).toBe(responseDigest.headline);
  });

  it("omits a Today Brief written from the briefing perspective while keeping paper TLDRs", async () => {
    stubFetch(
      mock(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ...responseDigest,
                    headline: "Today’s papers reveal a shared direction"
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, "Urban mobility");

    expect(result.todayBrief).toBeNull();
    expect(result.papers).toHaveLength(1);
  });

  it("omits a malformed Today Brief while keeping paper TLDRs", async () => {
    stubFetch(
      mock(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"headline":"Incomplete"}' } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, "Urban mobility");

    expect(result.todayBrief).toBeNull();
    expect(result.papers).toHaveLength(1);
  });

  it("throws a clear error when the configured summary API key is missing", async () => {
    await expect(
      createOpenAIEditorialSummarizer({ ...summaryConfig, apiKey: "" })(papers, "Urban mobility")
    ).rejects.toThrow("Missing summary API key.");
  });
});
