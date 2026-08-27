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
      takeaway: "交通网络约束成为城市出行预测的核心信息。",
      tldr: "该研究联合建模连续空间与交通网络以预测城市出行。"
    }
  ]
};

describe("createOpenAIEditorialSummarizer", () => {
  afterEach(() => {
    mock.restore();
  });

  it("requests one grounded editorial digest for the complete paper set", async () => {
    const fetchMock = mock(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(responseDigest) } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    stubFetch(fetchMock);

    const summarize = createOpenAIEditorialSummarizer(summaryConfig);
    const result = await summarize(papers, "Urban mobility and transport equity.");

    expect(result).toEqual(responseDigest);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer llm-key" }),
        body: expect.stringContaining('"model":"Qwen/Qwen3-8B"')
      })
    );
    const requestBody = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(requestBody).toContain("Chinese");
    expect(requestBody).toContain("Urban mobility and transport equity.");
    expect(requestBody).toContain("network structure and equitable urban mobility");
    expect(requestBody).toContain("one fluent, complete, conclusion-led sentence");
    expect(requestBody).toContain("Never return a noun phrase");
    expect(requestBody).toContain("faithful, concise translation and compression");
    expect(requestBody).toContain("using the title only as context");
    expect(requestBody).toContain("may use multiple fluent sentences");
    expect(requestBody).toContain("do not force it into one sentence");
    expect(requestBody).toContain("each takeaway to exactly 1 sentence");
    expect(requestBody).toContain("mention the reader or research profile");
    expect(requestBody).toContain("the single point the reader should remember");
    expect(requestBody).toContain("must not repeat the same sentence");
    expect(requestBody).toContain("conclusion-led sentence");
    expect(requestBody).toContain("must speak directly about the research");
    expect(requestBody).toContain("without introducing or summarizing the email itself");
    expect(requestBody).toContain('"max_tokens":2048');
    expect(requestBody).not.toContain('"subject":');
  });

  it("marks missing abstracts as title-only and requests a Chinese title translation", async () => {
    const fetchMock = mock(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...responseDigest,
                  papers: [
                    {
                      takeaway: "不得展示的推测性研究结论。",
                      tldr: "基于大型语言模型对复杂相对位置描述进行地理编码。"
                    }
                  ]
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    stubFetch(fetchMock);

    const titleOnlyPaper = {
      ...papers[0]!,
      title: "Georeferencing complex relative locality descriptions with large language models",
      abstract: "."
    };
    const result = await createOpenAIEditorialSummarizer(summaryConfig)([titleOnlyPaper], "Urban mobility");
    const requestBody = String(fetchMock.mock.calls[0]?.[1]?.body);

    expect(result.papers[0]).toEqual({
      takeaway: "不得展示的推测性研究结论。",
      tldr: "基于大型语言模型对复杂相对位置描述进行地理编码。",
      titleOnly: true
    });
    expect(requestBody).toContain("Source material: Title only (abstract unavailable)");
    expect(requestBody).toContain("make the tldr a faithful translation of the title");
    expect(requestBody).toContain("Headline and overview must remain at title level");
    expect(requestBody).not.toContain("Abstract: .");
  });

  it("requests a concise title summary when an English paper has no abstract", async () => {
    const fetchMock = mock(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  headline: "Large language models support locality georeferencing",
                  overview: "The work concerns georeferencing relative locality descriptions.",
                  preheader: "Georeferencing relative locality descriptions.",
                  papers: [
                    {
                      takeaway: "The paper concerns locality georeferencing with language models.",
                      tldr: "Using large language models to georeference complex relative locality descriptions."
                    }
                  ]
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    stubFetch(fetchMock);

    const result = await createOpenAIEditorialSummarizer({ ...summaryConfig, language: "English" })(
      [{ ...papers[0]!, abstract: "" }],
      "Urban mobility"
    );
    const requestBody = String(fetchMock.mock.calls[0]?.[1]?.body);

    expect(result.papers[0]?.titleOnly).toBeTrue();
    expect(requestBody).toContain("Write all reader-facing copy in English");
    expect(requestBody).toContain("a concise title summary when they are the same language");
  });

  it("accepts JSON wrapped in a markdown code fence", async () => {
    stubFetch(
      mock(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(responseDigest)}\n\`\`\`` } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, "Urban mobility");
    expect(result.headline).toBe(responseDigest.headline);
  });

  it("rejects headline and overview copy written from the briefing perspective", async () => {
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

    await expect(
      createOpenAIEditorialSummarizer(summaryConfig)(papers, "Urban mobility")
    ).rejects.toThrow("briefing meta-language");
  });

  it("rejects malformed output so delivery can use the non-LLM layout", async () => {
    stubFetch(
      mock(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"headline":"Incomplete"}' } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    await expect(
      createOpenAIEditorialSummarizer(summaryConfig)(papers, "Urban mobility")
    ).rejects.toThrow("wrong number of paper briefs");
  });

  it("throws a clear error when the configured summary API key is missing", async () => {
    await expect(
      createOpenAIEditorialSummarizer({ ...summaryConfig, apiKey: "" })(papers, "Urban mobility")
    ).rejects.toThrow("Missing summary API key.");
  });
});
