import { afterEach, describe, expect, it, mock } from "bun:test";
import type { SummaryConfig } from "../src/app-config.js";
import { createOpenAIEditorialSummarizer } from "../src/summary.js";
import type { InterestClusterSummary, RecommendedPaper } from "../src/types.js";
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
    matchContext: null
  }
];

const clusters: InterestClusterSummary[] = [
  { id: 2, labels: ["urban mobility", "transport equity"] }
];

const responseDigest = {
  headline: "空间结构进入城市预测核心",
  overview: "网络结构正成为改善城市出行预测的核心信息。",
  tldr: "该研究联合建模连续空间与交通网络以预测城市出行。"
};

function systemPrompt(requestBody: string): string {
  const payload = JSON.parse(requestBody) as { messages: Array<{ content: string }> };
  return payload.messages[0]?.content ?? "";
}

function successfulContent(requestBody: string): string {
  const prompt = systemPrompt(requestBody);
  if (prompt.includes("subject–verb–object phrase")) return responseDigest.headline;
  if (prompt.includes("concise editorial sentence")) return responseDigest.overview;
  return responseDigest.tldr;
}

function generationResponse(content: string, status = 200): Response {
  if (status !== 200) return new Response("unavailable", { status });
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("createOpenAIEditorialSummarizer", () => {
  afterEach(() => {
    mock.restore();
  });

  it("generates the Today Brief as headline and content before paper TLDRs", async () => {
    const requestKinds: string[] = [];
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body);
      const prompt = systemPrompt(body);
      requestKinds.push(
        prompt.includes("subject–verb–object phrase")
          ? "headline"
          : prompt.includes("concise editorial sentence")
            ? "overview"
            : "tldr"
      );
      return generationResponse(successfulContent(body));
    });
    stubFetch(fetchMock);

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);

    expect(result).toEqual({
      todayBrief: {
        headline: responseDigest.headline,
        overview: responseDigest.overview
      },
      papers: [{ tldr: responseDigest.tldr }]
    });
    expect(requestKinds).toEqual(["headline", "tldr", "overview"]);
    const requestBodies = fetchMock.mock.calls.map((call) => String(call[1]?.body));
    const briefBodies = requestBodies.filter((body) => !systemPrompt(body).includes("paper summary"));
    const headlineBody = requestBodies.find((body) =>
      systemPrompt(body).includes("subject–verb–object phrase")
    );
    const overviewBody = requestBodies.find((body) =>
      systemPrompt(body).includes("concise editorial sentence")
    );
    const tldrBody = requestBodies.find((body) => systemPrompt(body).includes("paper summary"));
    expect(headlineBody).not.toContain("Reader interest clusters");
    expect(headlineBody).not.toContain("Abstract:");
    expect(headlineBody).toContain("Title: Urban mobility");
    expect(overviewBody).toContain("Cluster 1: urban mobility; transport equity");
    expect(briefBodies.every((body) => !body.includes("Return only one JSON object"))).toBeTrue();
    expect(briefBodies.every((body) => body.includes('\"max_tokens\":512'))).toBeTrue();
    expect(tldrBody).toContain('\"max_tokens\":2048');

    const prompts = requestBodies.map(systemPrompt);
    expect(prompts.every((prompt) => prompt.length < 240)).toBeTrue();
    expect(prompts.every((prompt) => !/\b(?:do not|don't|never)\b/iu.test(prompt))).toBeTrue();
    expect(prompts.find((prompt) => prompt.includes("subject–verb–object phrase"))).toContain(
      "most significant candidate"
    );
    expect(prompts.find((prompt) => prompt.includes("subject–verb–object phrase"))).toContain(
      "10 English words or 14 Chinese characters"
    );
    expect(prompts.find((prompt) => prompt.includes("concise editorial sentence"))).toContain(
      "strongest one or two source insights"
    );
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
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        if (!systemPrompt(body).includes("paper summary")) {
          return generationResponse(successfulContent(body));
        }
        activePaperRequests += 1;
        maxActivePaperRequests = Math.max(maxActivePaperRequests, activePaperRequests);
        await paperRequestGate;
        activePaperRequests -= 1;
        return generationResponse(responseDigest.tldr);
      })
    );

    const resultPromise = createOpenAIEditorialSummarizer(summaryConfig)(manyPapers, clusters);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxActivePaperRequests).toBeGreaterThan(1);
    expect(maxActivePaperRequests).toBeLessThanOrEqual(4);
    releasePaperRequests?.();
    expect((await resultPromise).papers).toHaveLength(manyPapers.length);
  });

  it("lets the model choose the most important headline candidate", async () => {
    const secondPaper = {
      ...papers[0]!,
      title: "Large language models do not have emotions",
      abstract: "Language models can imitate emotional language without experiencing emotions.",
      url: "https://example.test/second-paper"
    };
    const fetchMock = mock(async (_url: string, init?: RequestInit) =>
      generationResponse(successfulContent(String(init?.body)))
    );
    stubFetch(fetchMock);

    await createOpenAIEditorialSummarizer(summaryConfig)([papers[0]!, secondPaper], clusters);

    const requestBodies = fetchMock.mock.calls.map((call) => String(call[1]?.body));
    const headlineBody = requestBodies.find((body) =>
      systemPrompt(body).includes("subject–verb–object phrase")
    );
    const overviewBody = requestBodies.find((body) =>
      systemPrompt(body).includes("concise editorial sentence")
    );
    expect(headlineBody).toContain("Candidate 1");
    expect(headlineBody).toContain("Urban mobility");
    expect(headlineBody).toContain("Candidate 2");
    expect(headlineBody).toContain(secondPaper.title);
    expect(headlineBody).not.toContain(secondPaper.abstract);
    expect(overviewBody).toContain(secondPaper.title);
  });

  it("starts paper TLDRs without waiting for the Today Brief", async () => {
    let releaseHeadline: (() => void) | undefined;
    const headlineGate = new Promise<void>((resolve) => {
      releaseHeadline = resolve;
    });
    let tldrStarted = false;
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        const prompt = systemPrompt(body);
        if (prompt.includes("subject–verb–object phrase")) {
          await headlineGate;
        }
        if (prompt.includes("paper summary")) {
          tldrStarted = true;
        }
        return generationResponse(successfulContent(body));
      })
    );

    const resultPromise = createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startedBeforeHeadlineCompleted = tldrStarted;
    releaseHeadline?.();
    await resultPromise;

    expect(startedBeforeHeadlineCompleted).toBeTrue();
  });

  it("limits total concurrent generation requests across the digest", async () => {
    const manyPapers = Array.from({ length: 8 }, (_, index) => ({
      ...papers[0]!,
      title: `Paper ${index}`,
      url: `https://example.test/limited-paper-${index}`
    }));
    let releaseRequests: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    let activeRequests = 0;
    let maxActiveRequests = 0;
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await requestGate;
        activeRequests -= 1;
        return generationResponse(successfulContent(String(init?.body)));
      })
    );

    const resultPromise = createOpenAIEditorialSummarizer(summaryConfig)(manyPapers, clusters);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const observedPeak = maxActiveRequests;
    releaseRequests?.();
    await resultPromise;

    expect(observedPeak).toBeLessThanOrEqual(4);
  });

  it("keeps successful TLDRs when a Today Brief field fails twice", async () => {
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        return systemPrompt(body).includes("subject–verb–object phrase")
          ? generationResponse("", 503)
          : generationResponse(successfulContent(body));
      })
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);

    expect(result.todayBrief).toBeNull();
    expect(result.papers).toEqual([{ tldr: responseDigest.tldr }]);
  });

  it("keeps the Today Brief when one paper TLDR fails twice", async () => {
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        return systemPrompt(body).includes("paper summary")
          ? generationResponse("", 503)
          : generationResponse(successfulContent(body));
      })
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);

    expect(result.todayBrief?.headline).toBe(responseDigest.headline);
    expect(result.papers[0]).toEqual({ tldr: "TLDR 暂时生成失败。", unavailable: true });
  });

  it("marks missing abstracts as title-only and retries a copied source title", async () => {
    const titleOnlyPaper = { ...papers[0]!, abstract: "" };
    let tldrRequests = 0;
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body);
      if (!systemPrompt(body).includes("paper summary")) {
        return generationResponse(successfulContent(body));
      }
      tldrRequests += 1;
      return generationResponse(tldrRequests === 1 ? titleOnlyPaper.title : "这篇论文聚焦城市移动性。");
    });
    stubFetch(fetchMock);

    const result = await createOpenAIEditorialSummarizer(summaryConfig)([titleOnlyPaper], clusters);
    const tldrBodies = fetchMock.mock.calls
      .map((call) => String(call[1]?.body))
      .filter((body) => systemPrompt(body).includes("paper summary"));

    expect(tldrRequests).toBe(2);
    expect(result.papers[0]).toEqual({ tldr: "这篇论文聚焦城市移动性。", titleOnly: true });
    expect(tldrBodies[0]).toContain("Source material: Title only (abstract unavailable)");
    expect(tldrBodies[0]).not.toContain("Abstract:");
    expect(systemPrompt(tldrBodies[0]!)).toContain("using only concepts named in it");
    expect(tldrBodies[1]).toContain("fresh wording that stays within the title's stated scope");
  });

  it("retries an overview that exposes source scaffolding", async () => {
    let overviewRequests = 0;
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        if (systemPrompt(body).includes("concise editorial sentence")) {
          overviewRequests += 1;
          return generationResponse(
            overviewRequests === 1
              ? "该标题对应论文0，此外 Paper 1 讨论另一个主题。"
              : responseDigest.overview
          );
        }
        return generationResponse(successfulContent(body));
      })
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);

    expect(overviewRequests).toBe(2);
    expect(result.todayBrief?.overview).toBe(responseDigest.overview);
  });

  it("retries an overview that is too long", async () => {
    let overviewRequests = 0;
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        if (systemPrompt(body).includes("concise editorial sentence")) {
          overviewRequests += 1;
          return generationResponse(
            overviewRequests === 1 ? "城市交通".repeat(11) : responseDigest.overview
          );
        }
        return generationResponse(successfulContent(body));
      })
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);

    expect(overviewRequests).toBe(2);
    expect(result.todayBrief?.overview).toBe(responseDigest.overview);
  });

  it("retries a short overview that lists other papers", async () => {
    let overviewRequests = 0;
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        if (systemPrompt(body).includes("concise editorial sentence")) {
          overviewRequests += 1;
          return generationResponse(
            overviewRequests === 1
              ? "交通扩展改变城市出行；此外，其他研究讨论语言模型与深度学习。"
              : responseDigest.overview
          );
        }
        return generationResponse(successfulContent(body));
      })
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);

    expect(overviewRequests).toBe(2);
    expect(result.todayBrief?.overview).toBe(responseDigest.overview);
  });

  it("retries an overview that repeats the headline", async () => {
    let overviewRequests = 0;
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        if (systemPrompt(body).includes("concise editorial sentence")) {
          overviewRequests += 1;
          return generationResponse(
            overviewRequests === 1
              ? "空间结构进入城市预测核心阶段。"
              : responseDigest.overview
          );
        }
        return generationResponse(successfulContent(body));
      })
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);

    expect(overviewRequests).toBe(2);
    expect(result.todayBrief?.overview).toBe(responseDigest.overview);
  });

  it("retries an editorial headline that is too long", async () => {
    let headlineRequests = 0;
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        if (systemPrompt(body).includes("subject–verb–object phrase")) {
          headlineRequests += 1;
          return generationResponse(
            headlineRequests === 1
              ? "多模式交通扩展如何重塑城市移动？"
              : responseDigest.headline
          );
        }
        return generationResponse(successfulContent(body));
      })
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);

    expect(headlineRequests).toBe(2);
    expect(result.todayBrief?.headline).toBe(responseDigest.headline);
  });

  it("allows up to ten English headline words", async () => {
    let headlineRequests = 0;
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        if (systemPrompt(body).includes("subject–verb–object phrase")) {
          headlineRequests += 1;
          return generationResponse(
            headlineRequests === 1
              ? "Urban transport networks reveal causal changes across rapidly growing megacity mobility"
              : "Transport networks reshape megacity mobility"
          );
        }
        return generationResponse(successfulContent(body));
      })
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);

    expect(headlineRequests).toBe(2);
    expect(result.todayBrief?.headline).toBe("Transport networks reshape megacity mobility");
  });

  it("accepts a compact thirteen-character Chinese headline", async () => {
    let headlineRequests = 0;
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        if (systemPrompt(body).includes("subject–verb–object phrase")) {
          headlineRequests += 1;
          return generationResponse("多模式网络扩展影响城市出行");
        }
        return generationResponse(successfulContent(body));
      })
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);

    expect(headlineRequests).toBe(1);
    expect(result.todayBrief?.headline).toBe("多模式网络扩展影响城市出行");
  });

  it("omits a Today Brief written from the briefing perspective", async () => {
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        return generationResponse(
          systemPrompt(body).includes("subject–verb–object phrase")
            ? "Today’s papers reveal a shared direction"
            : successfulContent(body)
        );
      })
    );

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);

    expect(result.todayBrief).toBeNull();
    expect(result.papers).toHaveLength(1);
  });

  it("throws a clear error when the configured summary API key is missing", async () => {
    await expect(
      createOpenAIEditorialSummarizer({ ...summaryConfig, apiKey: "" })(papers, clusters)
    ).rejects.toThrow("Missing summary API key.");
  });
});
