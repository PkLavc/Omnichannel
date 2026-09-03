import type { RetrievedDocument } from "./rag.js";

const STOP_WORDS = new Set([
  "a",
  "ao",
  "aos",
  "as",
  "com",
  "como",
  "da",
  "das",
  "de",
  "do",
  "dos",
  "e",
  "em",
  "essa",
  "esse",
  "esta",
  "este",
  "eu",
  "is",
  "me",
  "meu",
  "minha",
  "na",
  "nas",
  "no",
  "nos",
  "o",
  "os",
  "para",
  "por",
  "qual",
  "que",
  "the",
  "um",
  "uma",
]);

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Normalization used only for ranking; the original text remains untouched. */
export function normalizeForRanking(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(value: string) {
  const tokens = normalizeForRanking(value).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const canonical = tokens.map((token) =>
    token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token,
  );
  const filtered = canonical.filter((token) => !STOP_WORDS.has(token));
  return [...new Set(filtered.length ? filtered : canonical)];
}

function coverage(queryTokens: string[], textTokens: Set<string>) {
  if (!queryTokens.length) return 0;
  return queryTokens.filter((token) => textTokens.has(token)).length / queryTokens.length;
}

function bigrams(tokens: string[]) {
  return tokens.slice(0, -1).map((token, index) => `${token} ${tokens[index + 1]}`);
}

function lexicalScore(query: string, title: string, content: string) {
  const queryTokens = meaningfulTokens(query);
  if (!queryTokens.length) return 0;

  const normalizedTitle = normalizeForRanking(title);
  const normalizedContent = normalizeForRanking(content);
  const titleTokens = new Set(meaningfulTokens(title));
  const contentTokens = new Set(meaningfulTokens(content));
  const queryBigrams = bigrams(queryTokens);
  const documentText = `${normalizedTitle} ${normalizedContent}`;
  const bigramCoverage = queryBigrams.length
    ? queryBigrams.filter((bigram) => documentText.includes(bigram)).length / queryBigrams.length
    : 0;
  const normalizedQuery = normalizeForRanking(query);
  const exactPhrase = normalizedQuery.length >= 4 && documentText.includes(normalizedQuery) ? 1 : 0;

  return clamp(
    coverage(queryTokens, titleTokens) * 0.38
      + coverage(queryTokens, contentTokens) * 0.37
      + bigramCoverage * 0.15
      + exactPhrase * 0.1,
  );
}

export type RerankedDocument = RetrievedDocument & {
  rerankScore: number;
};

/**
 * Deterministic hybrid reranker.
 *
 * pgvector similarity remains the dominant signal while literal business
 * identifiers, product names and policy terms can promote the correct chunk.
 * Original rank is the final tie-breaker, so identical input always produces
 * identical output regardless of locale or database execution timing.
 */
export function rerankDocuments(
  query: string,
  documents: RetrievedDocument[],
  limit = documents.length,
): RerankedDocument[] {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, documents.length) : documents.length;
  return documents
    .map((document, originalRank) => {
      const semantic = clamp(Number(document.score));
      const lexical = lexicalScore(query, document.title, document.content);
      return {
        ...document,
        rerankScore: Number((semantic * 0.72 + lexical * 0.28).toFixed(8)),
        originalRank,
      };
    })
    .sort((left, right) =>
      right.rerankScore - left.rerankScore
      || right.score - left.score
      || left.originalRank - right.originalRank)
    .slice(0, safeLimit)
    .map(({ originalRank: _originalRank, ...document }) => document);
}
