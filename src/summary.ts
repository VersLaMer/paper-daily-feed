import type { SummaryConfig } from "./app-config.js";
import { hasMeaningfulAbstract } from "./text.js";
import type { InterestClusterSummary, RecommendedPaper } from "./types.js";

const MAX_ABSTRACT_INPUT_LENGTH = 4_000;
const PAPER_TLDR_CONCURRENCY = 4;
const GENERATION_REQUEST_CONCURRENCY = 4;
const GENERATION_REQUEST_TIMEOUT_MS = 60_000;
const MAX_HEADLINE_CJK_UNITS = 14;
const MAX_HEADLINE_WORDS = 10;
const MAX_OVERVIEW_CJK_UNITS = 32;
const MAX_OVERVIEW_WORDS = 20;
const BRIEFING_META_LANGUAGE = [
  /\b(?:this|the) (?:brief|briefing|digest|newsletter)\b/iu,
  /\b(?:today['’]s|these|the selected) papers\b/iu,
  /\bpaper\s*\d+\b/iu,
  /\bcandidate\s*\d+\b/iu,
  /\b(?:this|the) (?:email|recommendation|selection)\b/iu,
  /(?:本|这份|这个)(?:简报|摘要|邮件|推荐)/u,
  /(?:今天|今日|这些|本期|所选)(?:的)?论文/u,
  /(?:该|这个|上述)标题/u,
  /(?:论文|文章)\s*\d+/u
];
const OVERVIEW_LIST_LANGUAGE = [
  /\b(?:additionally|elsewhere|other (?:papers|studies)|also (?:covers|examines|explores))\b/iu,
  /(?:此外|另外|其余|其他)(?:论文|研究|内容|主题)?/u,
  /(?:还|也)(?:讨论|涵盖|介绍|关注)/u
];

export type PaperBrief = {
  tldr: string;
  titleOnly?: boolean;
  unavailable?: boolean;
};

export type TodayBrief = {
  headline: string;
  overview: string;
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

function sharesLongPhrase(left: string, right: string): boolean {
  const leftHan = left.match(/\p{Script=Han}/gu)?.join("") ?? "";
  const rightHan = right.match(/\p{Script=Han}/gu)?.join("") ?? "";
  const shorterHan = leftHan.length <= rightHan.length ? leftHan : rightHan;
  const longerHan = leftHan.length <= rightHan.length ? rightHan : leftHan;
  for (let index = 0; index <= shorterHan.length - 6; index += 1) {
    if (longerHan.includes(shorterHan.slice(index, index + 6))) return true;
  }

  const leftWords = canonicalText(left).split(" ").filter(Boolean);
  const rightText = ` ${canonicalText(right)} `;
  for (let index = 0; index <= leftWords.length - 3; index += 1) {
    if (rightText.includes(` ${leftWords.slice(index, index + 3).join(" ")} `)) return true;
  }
  return false;
}

function shortHeadline(value: unknown): string {
  const text = researchSynthesis(value, "headline");
  const hanCharacters = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const nonHanWords = text
    .replace(/\p{Script=Han}/gu, " ")
    .match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const units = hanCharacters + nonHanWords;
  const maxUnits = hanCharacters > 0 ? MAX_HEADLINE_CJK_UNITS : MAX_HEADLINE_WORDS;
  if (units > maxUnits) {
    throw new Error(`Generation API returned a headline over ${maxUnits} units.`);
  }
  return text;
}

function shortOverview(value: unknown, headline: string): string {
  const text = researchSynthesis(value, "overview");
  const hanCharacters = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const nonHanWords = text
    .replace(/\p{Script=Han}/gu, " ")
    .match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const units = hanCharacters + nonHanWords;
  const maxUnits = hanCharacters > 0 ? MAX_OVERVIEW_CJK_UNITS : MAX_OVERVIEW_WORDS;
  if (units > maxUnits) {
    throw new Error(`Generation API returned an overview over ${maxUnits} units.`);
  }
  const sentenceEndings = text.match(/[。！？!?]+|\.(?=\s+[A-Z]|$)/gu)?.length ?? 0;
  if (sentenceEndings > 1 || /[;；•]/u.test(text) || OVERVIEW_LIST_LANGUAGE.some((pattern) => pattern.test(text))) {
    throw new Error("Generation API returned a list-like overview.");
  }
  if (sharesLongPhrase(headline, text)) {
    throw new Error("Generation API returned an overview that repeats the headline.");
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
  return `Choose the most significant candidate. Write a very short ${language} headline as a subject–verb–object phrase, like “OpenAI shuts off Cursor” or “交通扩展改变出行”. Maximum: 10 English words or 14 Chinese characters. Return only the headline.`;
}

function overviewSystemPrompt(language: string): string {
  return `Write one compact editorial line in ${language}. Add a fresh source-backed detail beyond the headline, using fresh wording. Aim for 12–24 Chinese characters or 8–16 English words. Return only the line.`;
}

function paperBriefSystemPrompt(language: string, hasAbstract: boolean): string {
  return hasAbstract
    ? `Write one short ${language} paper summary from the supplied title and abstract. State one supported study focus or finding in one sentence. Return plain text.`
    : `Paraphrase the supplied title in one short ${language} paper summary using only concepts named in it. Mirror its scope and certainty. Return plain text.`;
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

function headlineCandidatesSource(papers: RecommendedPaper[]): string {
  return papers
    .map((paper, index) => `Candidate ${index + 1}\nJournal: ${paper.journal}\nTitle: ${paper.title}`)
    .join("\n\n");
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
    const correction = label === "headline"
      ? "Compress the headline into a subject–verb–object phrase like “交通扩展改变出行”. Maximum: 10 English words or 14 Chinese characters. Return only the headline."
      : label === "overview"
        ? "Compress to one clause. Target 16 Chinese characters or 12 English words, like “交通扩展重塑城市出行”. Return only the line."
      : `Write a valid ${label} as plain text using the source rules.`;
    return validate(
      plainTextResponse(
        await request(
          config,
          systemPrompt,
          `${source}\n\nCorrection: ${correction}`,
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
  const headlineSource = headlineCandidatesSource(papers);
  const headline = await generateBriefField(
    request,
    config,
    "headline",
    headlineSystemPrompt(config.language),
    headlineSource,
    Math.min(config.maxTokens, 512),
    shortHeadline
  );
  const overview = await generateBriefField(
    request,
    config,
    "overview",
    overviewSystemPrompt(config.language),
    `${source}\n\nHeadline: ${headline}`,
    Math.min(config.maxTokens, 512),
    (value) => shortOverview(value, headline)
  );
  return { headline, overview };
}

async function generatePaperBrief(
  request: GenerationRequest,
  config: SummaryConfig,
  paper: RecommendedPaper
): Promise<PaperBrief> {
  const systemPrompt = paperBriefSystemPrompt(
    config.language,
    hasMeaningfulAbstract(paper.abstract)
  );
  const source = paperSource(paper);
  try {
    return parsePaperBrief(await request(config, systemPrompt, source), paper);
  } catch {
    console.log(`[summary] Retrying TLDR for "${paper.title}" in ${config.language}.`);
    const correction = hasMeaningfulAbstract(paper.abstract)
      ? `Write a valid ${config.language} TLDR grounded in the supplied abstract.`
      : `Write a faithful ${config.language} introduction in fresh wording that stays within the title's stated scope.`;
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
