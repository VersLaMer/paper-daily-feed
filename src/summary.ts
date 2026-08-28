import type { SummaryConfig } from "./app-config.js";
import { hasMeaningfulAbstract } from "./text.js";
import type { RecommendedPaper } from "./types.js";

const MAX_ABSTRACT_INPUT_LENGTH = 4_000;
const PAPER_TLDR_CONCURRENCY = 4;
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
  researchProfile: string
) => Promise<EditorialDigest>;

function compact(value: string, maxLength = Number.POSITIVE_INFINITY): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function responseJson(content: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Generation API returned no JSON object.");
  }
  return JSON.parse(content.slice(start, end + 1));
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Generation API returned an invalid ${label}.`);
  }
  return compact(value);
}

function researchSynthesis(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (BRIEFING_META_LANGUAGE.some((pattern) => pattern.test(text))) {
    throw new Error(`Generation API returned ${label} with briefing meta-language.`);
  }
  return text;
}

function parseTodayBrief(value: unknown): TodayBrief {
  if (!value || typeof value !== "object") {
    throw new Error("Generation API returned an invalid Today Brief.");
  }

  const candidate = value as Record<string, unknown>;
  return {
    headline: researchSynthesis(candidate.headline, "headline"),
    overview: researchSynthesis(candidate.overview, "overview"),
    preheader: compact(requiredText(candidate.preheader, "preheader"), 180)
  };
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
  userPrompt: string
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
      ...(config.maxTokens ? { max_tokens: config.maxTokens } : {})
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

function todayBriefSystemPrompt(language: string): string {
  return [
    "You are the careful editor of a personalized academic paper briefing.",
    `Write all reader-facing copy in ${language}.`,
    "Generate the Today Brief from all supplied papers, treating them as the complete set selected for this delivery.",
    "Use only the supplied titles, abstracts, and research profile. Never invent results, claims, or trends.",
    "Choose the headline focus after considering the complete set. The headline may foreground one especially noteworthy paper, finding, method, or theme and does not need to represent every supplied paper.",
    "The headline must be one fluent, complete, conclusion-led sentence with a clear grammatical subject and predicate: name a research area, object, method, or direction and state what is changing, emerging, being revealed, or becoming possible.",
    "Never return a noun phrase, topic label, colon heading, keyword list, or stack of research terms as the headline.",
    "The headline and overview must speak directly about the research, never about the briefing process, the repository, the email, the editor, the reader, the recommendation, or the set of selected papers.",
    "Do not use framing such as this brief, this briefing, today's papers, these papers, the selected papers, we highlight, 本简报, 今天的论文, 这些论文, or 本期推荐.",
    "The overview must directly explain the headline's research conclusion with concrete methods, findings, contrasts, or shared directions from the supplied source material.",
    "Synthesize only when a genuine shared thread exists; otherwise state the distinct research directions directly without referring to the papers as a collection.",
    "When source material is marked Title only (abstract unavailable), remain strictly at title level and do not infer methods, results, contributions, significance, or trends.",
    "Keep the headline under 14 words, the overview to at most 2 sentences, and the preheader under 140 characters.",
    "Return only one JSON object with exactly these keys: headline, overview, preheader."
  ].join(" ");
}

function paperBriefSystemPrompt(language: string): string {
  return `You write concise one-sentence TLDR summaries for academic papers. Write the TLDR in ${language}. Use only the supplied source material and do not infer missing information. Return only the TLDR as plain text.`;
}

async function generatePaperBrief(
  config: SummaryConfig,
  paper: RecommendedPaper
): Promise<PaperBrief> {
  const systemPrompt = paperBriefSystemPrompt(config.language);
  const source = paperSource(paper);
  try {
    return parsePaperBrief(await requestGeneration(config, systemPrompt, source), paper);
  } catch {
    console.log(`[summary] Retrying TLDR for "${paper.title}" in ${config.language}.`);
    const correction = hasMeaningfulAbstract(paper.abstract)
      ? `Return a valid ${config.language} TLDR grounded only in the supplied abstract.`
      : `Return a faithful ${config.language} introduction to the title. Do not copy the source title verbatim, and do not infer details beyond it.`;
    return parsePaperBrief(
      await requestGeneration(
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
  return async (papers, researchProfile) => {
    if (!config.apiKey.trim()) {
      throw new Error("Missing summary API key.");
    }
    if (papers.length === 0) {
      throw new Error("Cannot generate an editorial digest without papers.");
    }

    const todayBriefSystem = todayBriefSystemPrompt(config.language);
    const todayBriefSource = `Reader research profile:\n${compact(researchProfile) || "No profile supplied."}\n\n${papers
      .map((paper, index) => paperSource(paper, index))
      .join("\n\n")}`;
    const todayBriefPromise = requestGeneration(config, todayBriefSystem, todayBriefSource)
      .then(responseJson)
      .then(parseTodayBrief)
      .catch(async (error) => {
        console.log(
          `[summary] Retrying Today Brief after failure: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return parseTodayBrief(
          responseJson(
            await requestGeneration(
              config,
              todayBriefSystem,
              `${todayBriefSource}\n\nCorrection: Return the requested valid JSON object only.`
            )
          )
        );
      })
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
          return await generatePaperBrief(config, paper);
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
