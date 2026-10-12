import { performance } from "node:perf_hooks";
import { TypeSafeClassifier, type Answer, type State } from "@langchain/typesafe";
import { DECISIONS, PATTERNS, RISK_LEVELS, type Decision, type Pattern, type RiskLevel } from "../domain/transaction.js";
import type { JevState } from "./mask.js";
import { QUESTION_SET_VERSION, QUESTIONS } from "./questions.js";

export interface Labeled<T extends string> {
  label: T;
  confidence: number;
  probabilities: Record<string, number>;
}

/** Jev's typed answers to the Vigil question set. */
export interface JevVerdict {
  fraudProbability: number;
  pattern: Labeled<Pattern>;
  riskLevel: Labeled<RiskLevel>;
  action: Labeled<Decision>;
  model: string;
  requestId: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  latencyMs: number;
  questionSetVersion: string;
}

export interface JevClient {
  classify(state: JevState): Promise<JevVerdict>;
}

/** Jev answered, but not in a shape Vigil can act on. */
export class JevAnswerError extends Error {
  override name = "JevAnswerError";
}

export interface TypeSafeJevClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs: number;
  maxRetries: number;
  fetch?: typeof fetch;
}

function expectType<T extends Answer["type"]>(answers: Record<string, Answer>, id: string, type: T) {
  const answer = answers[id];
  if (!answer || answer.type !== type) throw new JevAnswerError(`missing ${type} answer for "${id}"`);
  return answer as Extract<Answer, { type: T }>;
}

function oneOf<T extends string>(allowed: readonly T[], value: string, id: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new JevAnswerError(`unexpected "${id}" label "${value}"`);
  return value as T;
}

export function parseVerdict(answers: Record<string, Answer>): Omit<JevVerdict, "model" | "requestId" | "usage" | "latencyMs" | "questionSetVersion"> {
  const isFraud = expectType(answers, "is_fraud", "noul");
  const pattern = expectType(answers, "fraud_pattern", "choice");
  const risk = expectType(answers, "risk_level", "score");
  const action = expectType(answers, "action", "choice");
  const level = RISK_LEVELS[risk.score];
  if (level === undefined) throw new JevAnswerError(`risk_level index ${risk.score} out of range`);
  if (!(isFraud.noul >= 0 && isFraud.noul <= 1)) throw new JevAnswerError(`is_fraud ${isFraud.noul} not a probability`);

  return {
    fraudProbability: isFraud.noul,
    pattern: { label: oneOf(PATTERNS, pattern.choice, "fraud_pattern"), confidence: pattern.confidence, probabilities: pattern.probabilities },
    riskLevel: { label: level, confidence: risk.confidence, probabilities: risk.probabilities },
    action: { label: oneOf(DECISIONS, action.choice, "action"), confidence: action.confidence, probabilities: action.probabilities },
  };
}

/** Production client over the official SDK. One request answers all four questions. */
export class TypeSafeJevClient implements JevClient {
  private readonly classifier: TypeSafeClassifier;

  constructor(options: TypeSafeJevClientOptions) {
    this.classifier = new TypeSafeClassifier({
      questions: QUESTIONS,
      apiKey: options.apiKey,
      ...(options.baseUrl && { baseUrl: options.baseUrl }),
      ...(options.model && { model: options.model }),
      ...(options.fetch && { fetch: options.fetch }),
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries,
      dangerouslyAllowBrowser: false,
    });
  }

  async classify(state: JevState): Promise<JevVerdict> {
    const started = performance.now();
    const res = await this.classifier.invoke(state as unknown as State);
    return {
      ...parseVerdict(res.answers),
      model: res.model,
      requestId: res.requestId ?? null,
      usage: { inputTokens: res.usage.inputTokens ?? null, outputTokens: res.usage.outputTokens ?? null },
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      questionSetVersion: QUESTION_SET_VERSION,
    };
  }
}
