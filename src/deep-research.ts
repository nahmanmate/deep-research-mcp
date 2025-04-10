import { resolve } from 'path';
import { fileURLToPath } from 'url';
import FirecrawlApp, { SearchResponse } from '@mendable/firecrawl-js';
import { generateObject } from 'ai';
import { config } from 'dotenv';
import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { z } from 'zod';

import { o3MiniModel, trimPrompt } from './ai/providers.js';
import { firecrawl as firecrawlConfig } from './config.js';
import { OutputManager } from './output-manager.js';
import { systemPrompt } from './prompt.js';

// Get the directory name of the current module
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Load environment variables from .env.local
config({ path: resolve(__dirname, '../.env.local') });

// Initialize output manager for coordinated console/progress output
const output = new OutputManager();

// Replace console.log with output.log
function log(...args: any[]) {
  output.log(...args);
}

export type ResearchProgress = {
  currentDepth: number;
  totalDepth: number;
  currentBreadth: number;
  totalBreadth: number;
  currentQuery?: string;
  parentQuery?: string; // Track parent query for showing relationships
  totalQueries: number;
  completedQueries: number;
  learningsCount?: number; // Track learnings for this branch
  learnings?: string[]; // The actual learnings content
  followUpQuestions?: string[]; // Follow-up questions generated
};

type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
};

type SourceMetadata = {
  url: string;
  title?: string;
  publishDate?: string;
  domain: string;
  relevanceScore?: number;
  reliabilityScore: number;
  reliabilityReasoning: string;
};

// Configurable concurrency limit
const ConcurrencyLimit = firecrawlConfig.concurrency;

// Initialize Firecrawl with config
const firecrawl = new FirecrawlApp({
  apiKey: firecrawlConfig.apiKey,
  apiUrl: firecrawlConfig.baseUrl,
});

type LearningWithReliability = {
  content: string;
  reliability: number;
};

export type ResearchDirection = {
  question: string;
  priority: number;
  parentGoal?: string;  // Track which research goal led to this question
};

async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
  learningReliabilities,
  researchDirections = [],
}: {
  query: string;
  numQueries?: number;
  learnings?: string[];
  learningReliabilities?: number[];
  researchDirections?: ResearchDirection[];
}) {
  // Convert to properly typed weighted learnings
  const weightedLearnings: LearningWithReliability[] = learnings && learningReliabilities 
    ? learnings.map((content, i) => ({
        content,
        reliability: learningReliabilities[i] || 0.5
      }))
    : [];

  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following prompt from the user, generate a list of SERP queries to research the topic. Return a maximum of ${numQueries} queries, but feel free to return less if the original prompt is clear. Make sure each query is unique and not similar to each other.

${weightedLearnings.length > 0 
  ? `Here are previous learnings with their reliability scores (higher score means more reliable):
${weightedLearnings.map(l => `[Reliability: ${l.reliability.toFixed(2)}] ${l.content}`).join('\n')}

When generating new queries:
- Follow up on promising leads from reliable sources (reliability >= 0.7)
- For less reliable information (reliability < 0.7), consider generating verification queries that are likely to find authoritative sources
- Make each query specific and targeted to advance the research in a clear direction`
  : ''}

${researchDirections.length > 0 
  ? `\nPrioritized research directions to explore (higher priority = more important):
${researchDirections
  .sort((a, b) => b.priority - a.priority)
  .map(d => `[Priority: ${d.priority}] ${d.question}${d.parentGoal ? `\n  (From previous goal: ${d.parentGoal})` : ''}`)
  .join('\n')}

Focus on generating queries that address these research directions, especially the higher priority ones.`
  : ''}

<prompt>${query}</prompt>`,
    schema: z.object({
      queries: z
        .array(
          z.object({
            query: z.string().describe('The SERP query'),
            researchGoal: z
              .string()
              .describe(
                'First talk about the goal of the research that this query is meant to accomplish, then go deeper into how to advance the research once the results are found, mention additional research directions. Be as specific as possible, especially for additional research directions.',
              ),
            reliabilityThreshold: z
              .number()
              .describe('Minimum reliability score (between 0 and 1) needed for sources to be considered trustworthy for this query. Higher values (e.g. 0.7+) for verification queries, lower values (e.g. 0.3) for exploratory queries.'),
            isVerificationQuery: z
              .boolean()
              .describe('Whether this query is specifically trying to verify information from less reliable sources'),
            relatedDirection: z
              .string()
              .nullable()
              .describe('If this query addresses a specific research direction from the input, specify which one. Set to null if not applicable.')
          })
        )
        .describe(`List of SERP queries. Generate at most ${numQueries} queries, but feel free to return less if the original prompt is clear. Each query should be unique and advance the research in a meaningful way.`),
    }),
  });

  // Ensure reliability thresholds are within valid range
  const validatedQueries = res.object.queries.map(query => ({
    ...query,
    reliabilityThreshold: Math.max(0, Math.min(1, query.reliabilityThreshold))
  }));

  // Log more detailed information about query generation
  const verificationQueries = validatedQueries.filter(q => q.isVerificationQuery);
  if (verificationQueries.length > 0) {
    log(`Generated ${verificationQueries.length} verification queries to check information from less reliable sources`);
  }

  // Log which research directions are being addressed
  const queriesWithDirections = validatedQueries.filter(q => q.relatedDirection !== null);
  if (queriesWithDirections.length > 0) {
    log(`Queries addressing research directions:\n${queriesWithDirections
      .map(q => `- "${q.query}" addresses: ${q.relatedDirection}`)
      .join('\n')}`);
  }

  return validatedQueries;
}

async function evaluateSourceReliability(domain: string, context: string): Promise<{
  score: number;
  reasoning: string;
}> {
  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Evaluate the reliability of the following source domain for research about: "${context}"

Domain: ${domain}

Consider factors like:
1. Editorial standards and fact-checking processes
2. Domain expertise in the subject matter
3. Reputation for accuracy and objectivity
4. Transparency about sources and methodology
5. Professional vs user-generated content
6. Commercial biases or conflicts of interest
7. Academic or professional credentials
8. Track record in the field

Return a reliability score between 0 and 1, where:
- 0.9-1.0: Highest reliability (e.g. peer-reviewed journals, primary sources)
- 0.7-0.89: Very reliable (e.g. respected news organizations)
- 0.5-0.69: Moderately reliable (e.g. industry blogs with editorial oversight)
- 0.3-0.49: Limited reliability (e.g. personal blogs, commercial sites)
- 0-0.29: Low reliability (e.g. known misinformation sources)`,
    schema: z.object({
      score: z.number().describe('Reliability score between 0 and 1'),
      reasoning: z.string().describe('Brief explanation of the reliability assessment, one or two sentences'),
      domainExpertise: z.string().describe('Assessment of domain expertise in this specific topic')
    })
  });

  return {
    score: res.object.score,
    reasoning: res.object.reasoning
  };
}

async function processSerpResult({
  query,
  result,
  numLearnings = 3,
  numFollowUpQuestions = 3,
  reliabilityThreshold = 0.3,
  researchGoal = '',
}: {
  query: string;
  result: SearchResponse;
  numLearnings?: number;
  numFollowUpQuestions?: number;
  reliabilityThreshold?: number;
  researchGoal?: string;
}): Promise<{
  learnings: string[];
  learningConfidences: number[];
  followUpQuestions: string[];
  followUpPriorities: number[];
  sourceMetadata: SourceMetadata[];
  weightedLearnings: LearningWithReliability[];
}> {
  const contents = compact(result.data.map(item => item.markdown)).map(
    content => trimPrompt(content, 25_000),
  );

  // Evaluate source reliability for each domain
  const sourceMetadataPromises = compact(result.data.map(async item => {
    if (!item.url) return null;
    try {
      const domain = new URL(item.url).hostname;
      const reliability = await evaluateSourceReliability(domain, query);
      return {
        url: item.url,
        title: item.title || undefined,
        publishDate: undefined,
        domain,
        relevanceScore: undefined,
        reliabilityScore: reliability.score,
        reliabilityReasoning: reliability.reasoning
      } as SourceMetadata;
    } catch (e) {
      return null;
    }
  }));

  const sourceMetadata = compact(await Promise.all(sourceMetadataPromises));

  // Sort and filter contents by reliability
  const contentWithMetadata = contents
    .map((content, i) => ({
      content,
      metadata: sourceMetadata[i]
    }))
    .filter((item): item is { content: string; metadata: SourceMetadata } => !!item.metadata);

  // Sort by reliability and filter using the provided threshold
  const sortedContents = contentWithMetadata
    .sort((a, b) => b.metadata.reliabilityScore - a.metadata.reliabilityScore)
    .filter(item => item.metadata.reliabilityScore >= reliabilityThreshold)
    .map(item => item.content);

  log(`Ran ${query}, found ${contents.length} contents (${sourceMetadata.filter(m => m.reliabilityScore >= reliabilityThreshold).length} above reliability threshold ${reliabilityThreshold})`);

  const res = await generateObject({
    model: o3MiniModel,
    abortSignal: AbortSignal.timeout(60_000),
    system: systemPrompt(),
    prompt: `Given the following contents from a SERP search for the query <query>${query}</query>, generate a list of learnings from the contents. Return a maximum of ${numLearnings} learnings, but feel free to return less if the contents are clear. Make sure each learning is unique and not similar to each other. The learnings should be concise and to the point, as detailed and information dense as possible. Make sure to include any entities like people, places, companies, products, things, etc in the learnings, as well as any exact metrics, numbers, or dates.

${researchGoal ? `Research Goal: ${researchGoal}
This research is specifically aimed at: ${researchGoal}. Focus on findings that contribute to this goal.

` : ''}Weight information by source reliability - be more confident in information from highly reliable sources and more cautious about information from less reliable sources. If possible, try to verify information from less reliable sources against more reliable ones.

Also generate up to ${numFollowUpQuestions} follow-up questions, prioritized by reliability gaps and research needs${researchGoal ? ', keeping in mind the research goal' : ''}.

<contents>${contentWithMetadata
      .map(({ content, metadata }) => 
        `<content reliability="${metadata.reliabilityScore.toFixed(2)}" reasoning="${metadata.reliabilityReasoning}" source="${metadata.domain}">\n${content}\n</content>`
      )
      .join('\n')}</contents>`,
    schema: z.object({
      learnings: z
        .array(z.object({
          content: z.string(),
          confidence: z.number().describe('Confidence in this learning based on source reliability (between 0 and 1)'),
          sources: z.array(z.string()).describe('List of source domains that support this learning')
        }))
        .describe(`List of learnings, max of ${numLearnings}`),
      followUpQuestions: z
        .array(z.object({
          question: z.string(),
          priority: z.number().describe('Priority of this question (1-5) based on current source reliability gaps'),
          reason: z.string().describe('Why this follow-up is needed, especially regarding source reliability')
        }))
        .describe(`Follow-up questions to research, max of ${numFollowUpQuestions}, prioritized by reliability gaps`),
      sourceQuality: z.object({
        mostReliableSources: z.array(z.string()),
        contentGaps: z.array(z.string()),
        reliabilityAnalysis: z.string()
      })
    }),
  });

  // Create properly typed weighted learnings
  const weightedLearnings: LearningWithReliability[] = res.object.learnings.map(l => ({
    content: l.content,
    reliability: l.confidence
  }));

  // Ensure we don't exceed the numFollowUpQuestions limit
  const limitedFollowUpQuestions = res.object.followUpQuestions.slice(0, numFollowUpQuestions);

  return {
    ...res.object,
    sourceMetadata,
    learnings: weightedLearnings.map(l => l.content),
    learningConfidences: weightedLearnings.map(l => l.reliability),
    followUpQuestions: limitedFollowUpQuestions.map(q => q.question),
    followUpPriorities: limitedFollowUpQuestions.map(q => q.priority),
    weightedLearnings
  };
}

export async function writeFinalReport({
  prompt,
  learnings,
  sourceMetadata,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
  sourceMetadata: SourceMetadata[];
}) {
  // Quick reliability analysis
  const reliabilityGroups = {
    high: sourceMetadata.filter(m => m.reliabilityScore >= 0.8),
    medium: sourceMetadata.filter(m => m.reliabilityScore >= 0.5 && m.reliabilityScore < 0.8),
    low: sourceMetadata.filter(m => m.reliabilityScore < 0.5)
  };

  const learningsString = trimPrompt(
    learnings
      .map(learning => `<learning>\n${learning}\n</learning>`)
      .join('\n'),
    150_000,
  );

  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following prompt from the user, write a final report on the topic using the learnings from research. Make it as detailed as possible, aim for 3 or more pages, include ALL the learnings from research. Consider source reliability when drawing conclusions.

<prompt>${prompt}</prompt>

Here are all the learnings from previous research:

<learnings>\n${learningsString}\n</learnings>`,
    schema: z.object({
      reportMarkdown: z.string().describe('Final report on the topic in Markdown'),
    }),
  });

  // Add a simple sources section with reliability scores
  const sourcesSection = '\n\n## Sources\n\n' + sourceMetadata
    .sort((a, b) => b.reliabilityScore - a.reliabilityScore)
    .map(metadata => {
      const parts = [
        `- ${metadata.url}`,
        `  - Reliability: ${metadata.reliabilityScore.toFixed(2)} - ${metadata.reliabilityReasoning}`,
      ];
      if (metadata.title) {
        parts.push(`  - Title: ${metadata.title}`);
      }
      if (metadata.publishDate) {
        parts.push(`  - Published: ${metadata.publishDate}`);
      }
      return parts.join('\n');
    })
    .join('\n\n');

  return res.object.reportMarkdown + sourcesSection;
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  learningReliabilities = [],
  visitedUrls = [],
  weightedLearnings = [],
  researchDirections = [],  // Add structured research directions
  onProgress,
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  learningReliabilities?: number[];
  visitedUrls?: string[];
  weightedLearnings?: LearningWithReliability[];
  researchDirections?: ResearchDirection[];  // New parameter
  onProgress?: (progress: ResearchProgress) => void;
}): Promise<{
  learnings: string[];
  learningReliabilities: number[];
  visitedUrls: string[];
  sourceMetadata: SourceMetadata[];
  weightedLearnings: LearningWithReliability[];
}> {
  const progress: ResearchProgress = {
    currentDepth: depth,
    totalDepth: depth,
    currentBreadth: breadth,
    totalBreadth: breadth,
    totalQueries: 0,
    completedQueries: 0,
  };

  const reportProgress = (update: Partial<ResearchProgress>) => {
    Object.assign(progress, update);
    onProgress?.(progress);
  };

  const serpQueries = await generateSerpQueries({
    query,
    learnings,
    learningReliabilities,
    numQueries: breadth,
    researchDirections,  // Pass research directions to influence query generation
  });

  reportProgress({
    totalQueries: serpQueries.length,
    currentQuery: serpQueries[0]?.query,
  });

  const limit = pLimit(ConcurrencyLimit);

  const results = await Promise.all(
    serpQueries.map(serpQuery =>
      limit(async () => {
        try {
          const result = await firecrawl.search(serpQuery.query, {
            timeout: 15000,
            limit: serpQuery.isVerificationQuery ? 8 : 5,
            scrapeOptions: { 
              formats: ['markdown']
            },
          });

          // Collect URLs from this search
          const newUrls = compact(result.data.map(item => item.url));
          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;

          const processedResult = await processSerpResult({
            query: serpQuery.query,
            result,
            numFollowUpQuestions: newBreadth,
            reliabilityThreshold: serpQuery.reliabilityThreshold,
            researchGoal: serpQuery.researchGoal,
          });
          
          const allLearnings = [...learnings, ...processedResult.learnings];
          const allUrls = [...visitedUrls, ...newUrls];
          const allSourceMetadata = [...(processedResult.sourceMetadata || [])];
          const allWeightedLearnings = [...weightedLearnings, ...processedResult.weightedLearnings];

          if (newDepth > 0) {
            log(
              `Researching deeper, breadth: ${newBreadth}, depth: ${newDepth}`,
            );

            reportProgress({
              currentDepth: newDepth,
              currentBreadth: newBreadth,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
              parentQuery: query,
              learningsCount: processedResult.learnings.length,
              learnings: processedResult.learnings,
              followUpQuestions: processedResult.followUpQuestions,
            });

            const nextQuery = `
Previous research goal: ${serpQuery.researchGoal}
Follow-up research directions: ${processedResult.followUpQuestions.map(q => `\n${q}`).join('')}
`.trim();

            return deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: newDepth,
              learnings: allLearnings,
              learningReliabilities: processedResult.learningConfidences,
              visitedUrls: allUrls,
              weightedLearnings: allWeightedLearnings,
              researchDirections: processedResult.followUpQuestions.map((q, i) => ({
                question: q,
                priority: processedResult.followUpPriorities[i] || 3, // Default priority if undefined
                parentGoal: serpQuery.researchGoal
              })),
              onProgress,
            });
          } else {
            reportProgress({
              currentDepth: 0,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
            });
            return {
              learnings: allLearnings,
              learningReliabilities: processedResult.learningConfidences,
              visitedUrls: allUrls,
              sourceMetadata: allSourceMetadata,
              weightedLearnings: allWeightedLearnings
            };
          }
        } catch (e: any) {
          if (e.message && e.message.includes('Timeout')) {
            log(`Timeout error running query: ${serpQuery.query}: `, e);
          } else {
            log(`Error running query: ${serpQuery.query}: `, e);
          }
          return {
            learnings: [],
            learningReliabilities: [],
            visitedUrls: [],
            sourceMetadata: [],
            weightedLearnings: []
          };
        }
      }),
    ),
  );

  const combinedResults = {
    learnings: [...new Set(results.flatMap(r => r.learnings))],
    learningReliabilities: [...new Set(results.flatMap(r => r.learningReliabilities))],
    visitedUrls: [...new Set(results.flatMap(r => r.visitedUrls))],
    sourceMetadata: [...new Set(results.flatMap(r => r.sourceMetadata))],
    weightedLearnings: [...new Set(results.flatMap(r => r.weightedLearnings))]
  };

  return combinedResults;
}