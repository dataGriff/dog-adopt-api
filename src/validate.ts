import type { z } from 'zod';
import { ProblemError, zodIssuesToErrors } from './problems.js';

/** Parses with a generated contract schema; a failure is a 400 problem. */
export function parseOr400<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProblemError('validation_failed', `Invalid ${what}`, zodIssuesToErrors(result.error));
  return result.data;
}

/** Parses path params; a malformed id is treated as not found, the only error the contract declares for it. */
export function parseOr404<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProblemError('not_found');
  return result.data;
}
