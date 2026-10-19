import { PROBLEM_TYPES, type Problem } from '@dogadopt/contracts';
import type { ZodError } from 'zod';

type ErrorCode = Problem['errorCode'];

const TITLES: Record<ErrorCode, string> = {
  validation_failed: 'The request did not validate',
  not_found: 'No such resource',
  unauthorized: 'Missing or invalid service token',
  idempotency_conflict: 'Idempotency-Key already used with a different body',
  internal_error: 'Something went wrong',
};

const STATUSES: Record<ErrorCode, number> = {
  validation_failed: 400,
  not_found: 404,
  unauthorized: 401,
  idempotency_conflict: 409,
  internal_error: 500,
};

/** Thrown anywhere in a handler; app.onError turns it into a problem response. */
export class ProblemError extends Error {
  constructor(
    readonly errorCode: ErrorCode,
    readonly detail?: string,
    readonly errors?: Problem['errors'],
  ) {
    super(detail ?? TITLES[errorCode]);
  }
}

export function problemResponse(code: ErrorCode, detail?: string, errors?: Problem['errors'], instance?: string): Response {
  const body: Problem = {
    type: PROBLEM_TYPES[code],
    title: TITLES[code],
    status: STATUSES[code],
    errorCode: code,
    ...(detail ? { detail } : {}),
    ...(instance ? { instance } : {}),
    ...(errors && errors.length ? { errors } : {}),
  };
  return new Response(JSON.stringify(body), {
    status: STATUSES[code],
    headers: { 'content-type': 'application/problem+json' },
  });
}

export function zodIssuesToErrors(error: ZodError): NonNullable<Problem['errors']> {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.') || '(root)', message: issue.message }));
}
