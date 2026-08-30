import type { SummaryConfig } from "./app-config.js";
import { hasMeaningfulAbstract } from "./text.js";
import type { InterestClusterSummary, RecommendedPaper } from "./types.js";

const MAX_ABSTRACT_INPUT_LENGTH = 4_000;
const PAPER_TLDR_CONCURRENCY = 4;
const GENERATION_REQUEST_CONCURRENCY = 4;
const GENERATION_REQUEST_TIMEOUT_MS = 60_000;
const BRIEFING_META_LANGUAGE = [
  /\b(?:this|the) (?:brief|briefing|digest|newsletter)\b/iu,
  /\b(?:today['’]s|these|the selected) papers\b/iu,
  /\b(?:this|the) (?:email|recommendation|selection)\b/iu,
  /(?:本|这份|这个)(?:简报|摘要|邮件|推荐)/u,
  /(?:今天|今日|这些|本期|所选)(?:的)?论文/u
];

export type PaperBrief = {
  tldr: string;
  titleOnly?: boolean;
  unavailable?: boolean;
};

export type TodayBrief = {
  headline: string;
  overview: string;
  preheader: string;
};

export type EditorialDigest = {
  todayBrief: TodayBrief | null;
  papers: PaperBrief[];
};

export type SummarizeDigest = (
  papers: RecommendedPaper[],
  interestClusters: InterestClusterSummary[]
) => Promise<EditorialDigest>;

function compact(value: string, maxLength = Number.POSITIVE_INFINITY): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Generation API returned an invalid ${label}.`);
  }
  return compact(value);
}

function responseJson(content: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Generation API returned no JSON object.");
  }
  return JSON.parse(content.slice(start, end + 1));
}

function researchSynthesis(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (BRIEFING_META_LANGUAGE.some((pattern) => pattern.test(text))) {
    throw new Error(`Generation API returned ${label} with briefing meta-language.`);
  }
  return text;
}

function plainTextResponse(content: string, label: string): string {
  const value = content
    .replace(/^```[a-z]*\s*/iu, "")
    .replace(/\s*```$/u, "")
    .replace(new RegExp(`^\\s*${label}\\s*:\\s*`, "iu"), "")
    .replace(/^["“”']|["“”']$/gu, "")
    .trim();
  return requiredText(value, label);
}

function parsePaperBrief(value: string, paper: RecommendedPaper): PaperBrief {
  let content = value
    .replace(/^```[a-z]*\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  if (content.startsWith("{")) {
    const legacy = responseJson(content) as { tldr?: unknown };
    if (typeof legacy.tldr === "string") content = legacy.tldr;
  }
  const tldr = content.replace(/^\s*TLDR\s*:\s*/iu, "").trim();
  if (!tldr) {
    throw new Error(`Generation API returned an invalid tldr for "${paper.title}".`);
  }
  const titleOnly = !hasMeaningfulAbstract(paper.abstract);
  if (titleOnly && canonicalText(tldr) === canonicalText(paper.title)) {
    throw new Error(`Generation API repeated the source title for "${paper.title}".`);
  }
  return {
    tldr: compact(tldr),
    ...(titleOnly ? { titleOnly: true } : {})
  };
}

function canonicalText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function paperSource(paper: RecommendedPaper, index?: number): string {
  const hasAbstract = hasMeaningfulAbstract(paper.abstract);
  return [
    ...(index === undefined ? [] : [`Paper ${index}`]),
    `Journal: ${paper.journal}`,
    `Title: ${paper.title}`,
    `Source material: ${hasAbstract ? "Title and abstract" : "Title only (abstract unavailable)"}`,
    ...(hasAbstract ? [`Abstract: ${compact(paper.abstract, MAX_ABSTRACT_INPUT_LENGTH)}`] : [])
  ].join("\n");
}

async function requestGeneration(
  config: SummaryConfig,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = config.maxTokens
): Promise<string> {
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(GENERATION_REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${config.apiKey.trim()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.2,
      ...(maxTokens ? { max_tokens: maxTokens } : {})
    })
  });

  if (!response.ok) {
    throw new Error(`Generation API request failed (${response.status} ${response.statusText}).`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Generation API returned empty content.");
  }
  return content;
}

type GenerationRequest = typeof requestGeneration;

function createGenerationRequestLimiter(maxConcurrent: number): GenerationRequest {
  let activeRequests = 0;
  const waiters: Array<() => void> = [];

  return async (...args) => {
    if (activeRequests >= maxConcurrent) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    activeRequests += 1;
    try {
      return await requestGeneration(...args);
    } finally {
      activeRequests -= 1;
      waiters.shift()?.();
    }
  };
}

function headlineSystemPrompt(language: string): string {
  return `Write one conclusion-led academic research headline in ${language}. Use only the supplied sources. It may focus on one strong theme or paper. Use a complete sentence under 14 words, never a topic label or briefing language. Return only the headline as plain text.`;
}

function overviewSystemPrompt(language: string): string {
  return `Explain the supplied headline in ${language} using concrete information from the supplied sources. Use at most two sentences. Do not mention the email, briefing, recommendation, reader, or selected papers. Do not infer beyond title-only sources. Return only the overview as plain text.`;
}

function preheaderSystemPrompt(language: string): string {
  return `Write one email preheader in ${language}, under 140 characters, grounded in the supplied headline and paper titles. Return only the preheader as plain text.`;
}

function paperBriefSystemPrompt(language: string): string {
  return `You write concise one-sentence TLDR summaries for academic papers. Write the TLDR in ${language}. Use only the supplied source material and do not infer missing information. Return only the TLDR as plain text.`;
}

function todayBriefSource(
  papers: RecommendedPaper[],
  interestClusters: InterestClusterSummary[]
): string {
  const clusters = interestClusters.length > 0
    ? interestClusters.map((cluster, index) => `Cluster ${index + 1}: ${cluster.labels.join("; ")}`).join("\n")
    : "No reader interest clusters supplied.";
  return `Reader interest clusters (aggregated labels only):\n${clusters}\n\n${papers
    .map((paper, index) => paperSource(paper, index))
    .join("\n\n")}`;
}

async function generateBriefField(
  request: GenerationRequest,
  config: SummaryConfig,
  label: string,
  systemPrompt: string,
  source: string,
  maxTokens: number,
  validate: (value: string) => string
): Promise<string> {
  try {
    return validate(plainTextResponse(await request(config, systemPrompt, source, maxTokens), label));
  } catch (error) {
    console.log(
      `[summary] Retrying Today Brief ${label} after failure: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return validate(
      plainTextResponse(
        await request(
          config,
          systemPrompt,
          `${source}\n\nCorrection: Return only a valid ${label} as plain text.`,
          maxTokens
        ),
        label
      )
    );
  }
}

async function generateTodayBrief(
  request: GenerationRequest,
  config: SummaryConfig,
  papers: RecommendedPaper[],
  interestClusters: InterestClusterSummary[]
): Promise<TodayBrief> {
  const source = todayBriefSource(papers, interestClusters);
  const headline = await generateBriefField(
    request,
    config,
    "headline",
    headlineSystemPrompt(config.language),
    source,
    Math.min(config.maxTokens, 512),
    (value) => researchSynthesis(value, "headline")
  );
  const [overview, preheader] = await Promise.all([
    generateBriefField(
      request,
      config,
      "overview",
      overviewSystemPrompt(config.language),
      `${source}\n\nHeadline: ${headline}`,
      Math.min(config.maxTokens, 512),
      (value) => researchSynthesis(value, "overview")
    ),
    generateBriefField(
      request,
      config,
      "preheader",
      preheaderSystemPrompt(config.language),
      `Headline: ${headline}\n\nPaper titles:\n${papers.map((paper) => `- ${paper.title}`).join("\n")}`,
      Math.min(config.maxTokens, 512),
      (value) => compact(requiredText(value, "preheader"), 180)
    )
  ]);
  return { headline, overview, preheader };
}

async function generatePaperBrief(
  request: GenerationRequest,
  config: SummaryConfig,
  paper: RecommendedPaper
): Promise<PaperBrief> {
  const systemPrompt = paperBriefSystemPrompt(config.language);
  const source = paperSource(paper);
  try {
    return parsePaperBrief(await request(config, systemPrompt, source), paper);
  } catch {
    console.log(`[summary] Retrying TLDR for "${paper.title}" in ${config.language}.`);
    const correction = hasMeaningfulAbstract(paper.abstract)
      ? `Return a valid ${config.language} TLDR grounded only in the supplied abstract.`
      : `Return a faithful ${config.language} introduction to the title. Do not copy the source title verbatim, and do not infer details beyond it.`;
    return parsePaperBrief(
      await request(
        config,
        systemPrompt,
        `${source}\n\nCorrection: ${correction}`
      ),
      paper
    );
  }
}

function unavailablePaperBrief(language: string, paper: RecommendedPaper): PaperBrief {
  const chinese = /(?:chinese|中文|汉语|漢語|简体|簡體|繁体|繁體)/iu.test(language);
  const tldr = chinese
    ? hasMeaningfulAbstract(paper.abstract)
      ? "TLDR 暂时生成失败。"
      : "未提供摘要，TLDR 暂时无法生成。"
    : hasMeaningfulAbstract(paper.abstract)
      ? "TLDR generation is temporarily unavailable."
      : "No abstract was provided, so a TLDR could not be generated.";
  return { tldr, unavailable: true };
}

async function mapConcurrently<TInput, TOutput>(
  inputs: TInput[],
  concurrency: number,
  transform: (input: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const output = new Array<TOutput>(inputs.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), inputs.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await transform(inputs[index]!);
    }
  });
  await Promise.all(workers);
  return output;
}

export function createOpenAIEditorialSummarizer(config: SummaryConfig): SummarizeDigest {
  return async (papers, interestClusters) => {
    if (!config.apiKey.trim()) {
      throw new Error("Missing summary API key.");
    }
    if (papers.length === 0) {
      throw new Error("Cannot generate an editorial digest without papers.");
    }

    const request = createGenerationRequestLimiter(GENERATION_REQUEST_CONCURRENCY);
    const todayBriefPromise = generateTodayBrief(request, config, papers, interestClusters)
      .catch((error) => {
        console.log(
          `[summary] Today Brief generation failed; keeping paper TLDRs: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return null;
      });
    const paperBriefsPromise = mapConcurrently(
      papers,
      PAPER_TLDR_CONCURRENCY,
      async (paper) => {
        try {
          return await generatePaperBrief(request, config, paper);
        } catch (error) {
          console.log(
            `[summary] TLDR generation failed for "${paper.title}" after retry: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return unavailablePaperBrief(config.language, paper);
        }
      }
    );

    const [todayBrief, paperBriefs] = await Promise.all([todayBriefPromise, paperBriefsPromise]);

    return { todayBrief, papers: paperBriefs };
  };
}
