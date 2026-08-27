import * as pl from "tau-prolog";
import installLists = require("tau-prolog/modules/lists");

installLists(pl);
const STANDARD_MODULES = ":- use_module(library(lists)).\n";

export interface QueryOptions {
  maxAnswers?: number;
  inferenceLimit?: number;
  timeoutMs?: number;
}

export interface PrologQueryResult {
  query: string;
  success: boolean;
  answers: string[];
  answerCount: number;
  exhausted: boolean;
  truncated: boolean;
}

const DEFAULT_MAX_ANSWERS = 20;
const DEFAULT_INFERENCE_LIMIT = 100_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function terminated(source: string): string {
  const value = source.trim();
  return value.endsWith(".") ? value : `${value}.`;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function message(error: any): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error.toString === "function") return error.toString();
  return String(error);
}

/** Consult a fresh, isolated Tau Prolog session and enumerate bounded answers. */
export async function runPrologQuery(
  program: string,
  query: string,
  options: QueryOptions = {}
): Promise<PrologQueryResult> {
  if (!program.trim()) throw new Error("The Prolog program must not be empty");
  if (!query.trim()) throw new Error("The Prolog query must not be empty");

  const maxAnswers = boundedInteger(options.maxAnswers, DEFAULT_MAX_ANSWERS, 1, 100);
  const inferenceLimit = boundedInteger(
    options.inferenceLimit,
    DEFAULT_INFERENCE_LIMIT,
    100,
    2_000_000
  );
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 50, 30_000);
  const normalizedQuery = terminated(query);
  const session = pl.create(inferenceLimit);

  return new Promise<PrologQueryResult>((resolve, reject) => {
    let settled = false;
    const answers: string[] = [];
    const finish = (exhausted: boolean, truncated: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        query: normalizedQuery,
        success: answers.length > 0,
        answers,
        answerCount: answers.length,
        exhausted,
        truncated,
      });
    };
    const fail = (prefix: string, error: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${prefix}: ${message(error)}`));
    };
    const timer = setTimeout(
      () => fail("Prolog evaluation timed out", `${timeoutMs}ms limit exceeded`),
      timeoutMs
    );

    const nextAnswer = () => {
      if (settled) return;
      session.answer({
        success: (answer: any) => {
          answers.push(pl.format_answer(answer));
          if (answers.length >= maxAnswers) finish(false, true);
          else nextAnswer();
        },
        fail: () => finish(true, false),
        error: (error: any) => fail("Prolog runtime error", error),
        limit: () => fail("Prolog inference limit exceeded", inferenceLimit),
      });
    };

    session.consult(STANDARD_MODULES + terminated(program), {
      success: () => session.query(normalizedQuery, {
        success: nextAnswer,
        error: (error: any) => fail("Invalid Prolog query", error),
      }),
      error: (error: any) => fail("Invalid Prolog program", error),
    });
  });
}

export function validateActionTerm(action: string): string {
  const term = action.trim();
  if (!term) throw new Error("Plan actions must not be empty");
  // An action occupies one list element. Reject syntax that could escape the generated list/query.
  if (/[.\[\]]/.test(term)) {
    throw new Error(`Invalid action term '${action}': periods and list brackets are not allowed`);
  }
  return term;
}
