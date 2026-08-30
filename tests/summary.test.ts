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
  preheader: "首选论文将网络拓扑直接纳入预测。",
  tldr: "该研究联合建模连续空间与交通网络以预测城市出行。"
};

function systemPrompt(requestBody: string): string {
  const payload = JSON.parse(requestBody) as { messages: Array<{ content: string }> };
  return payload.messages[0]?.content ?? "";
}

function successfulContent(requestBody: string): string {
  const prompt = systemPrompt(requestBody);
  if (prompt.includes("academic research headline")) return responseDigest.headline;
  if (prompt.includes("Explain the supplied headline")) return responseDigest.overview;
  if (prompt.includes("email preheader")) return responseDigest.preheader;
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

  it("generates the Today Brief as three plain-text fields before paper TLDRs", async () => {
    const requestKinds: string[] = [];
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body);
      const prompt = systemPrompt(body);
      requestKinds.push(
        prompt.includes("academic research headline")
          ? "headline"
          : prompt.includes("Explain the supplied headline")
            ? "overview"
            : prompt.includes("email preheader")
              ? "preheader"
              : "tldr"
      );
      return generationResponse(successfulContent(body));
    });
    stubFetch(fetchMock);

    const result = await createOpenAIEditorialSummarizer(summaryConfig)(papers, clusters);

    expect(result).toEqual({
      todayBrief: {
        headline: responseDigest.headline,
        overview: responseDigest.overview,
        preheader: responseDigest.preheader
      },
      papers: [{ tldr: responseDigest.tldr }]
    });
    expect(requestKinds).toEqual(["headline", "tldr", "overview", "preheader"]);
    const requestBodies = fetchMock.mock.calls.map((call) => String(call[1]?.body));
    const briefBodies = requestBodies.filter((body) => !systemPrompt(body).includes("TLDR summaries"));
    const tldrBody = requestBodies.find((body) => systemPrompt(body).includes("TLDR summaries"));
    expect(briefBodies[0]).toContain("Cluster 1: urban mobility; transport equity");
    expect(briefBodies[0]).toContain("network structure and equitable urban mobility");
    expect(briefBodies.every((body) => !body.includes("Return only one JSON object"))).toBeTrue();
    expect(briefBodies.every((body) => body.includes('\"max_tokens\":512'))).toBeTrue();
    expect(tldrBody).toContain('\"max_tokens\":2048');
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
        if (!systemPrompt(body).includes("TLDR summaries")) {
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
        if (prompt.includes("academic research headline")) {
          await headlineGate;
        }
        if (prompt.includes("TLDR summaries")) {
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
        return systemPrompt(body).includes("academic research headline")
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
        return systemPrompt(body).includes("TLDR summaries")
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
      if (!systemPrompt(body).includes("TLDR summaries")) {
        return generationResponse(successfulContent(body));
      }
      tldrRequests += 1;
      return generationResponse(tldrRequests === 1 ? titleOnlyPaper.title : "这篇论文聚焦城市移动性。");
    });
    stubFetch(fetchMock);

    const result = await createOpenAIEditorialSummarizer(summaryConfig)([titleOnlyPaper], clusters);
    const tldrBodies = fetchMock.mock.calls
      .map((call) => String(call[1]?.body))
      .filter((body) => systemPrompt(body).includes("TLDR summaries"));

    expect(tldrRequests).toBe(2);
    expect(result.papers[0]).toEqual({ tldr: "这篇论文聚焦城市移动性。", titleOnly: true });
    expect(tldrBodies[0]).toContain("Source material: Title only (abstract unavailable)");
    expect(tldrBodies[0]).not.toContain("Abstract:");
    expect(tldrBodies[1]).toContain("Do not copy the source title verbatim");
  });

  it("omits a Today Brief written from the briefing perspective", async () => {
    stubFetch(
      mock(async (_url: string, init?: RequestInit) => {
        const body = String(init?.body);
        return generationResponse(
          systemPrompt(body).includes("academic research headline")
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
