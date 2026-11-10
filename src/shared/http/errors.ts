import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { ConfigError } from '../../config';
import { PayPalApiError, PayPalNetworkError } from '../../paypal/types';

/** An error with an HTTP status and a PayPal-style body: { name, message, details? }. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorName: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string, id: string) => new HttpError(404, 'RESOURCE_NOT_FOUND', `${what} ${id} not found`);

/** Express 4 does not catch rejected promises; this forwards them to the error handler. */
export function route(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function zodDetails(e: ZodError) {
  return e.issues.map((i) => ({ field: i.path.join('.') || '(body)', issue: i.code, description: i.message }));
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ name: err.errorName, message: err.message, details: err.details });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ name: 'INVALID_REQUEST', message: 'Request body is not valid.', details: zodDetails(err) });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ name: 'INVALID_REQUEST', message: 'Body is not valid JSON.' });
  }
  if (err instanceof ConfigError) {
    return res.status(503).json({ name: 'NOT_CONFIGURED', message: err.message });
  }
  if (err instanceof PayPalApiError) {
    return res.status(502).json({ name: 'PAYPAL_ERROR', message: err.message, details: err.toJSON() });
  }
  if (err instanceof PayPalNetworkError) {
    return res.status(504).json({ name: 'PAYPAL_UNREACHABLE', message: err.message });
  }
  // Vercel AI SDK errors are named AI_*; their message is the provider's (no key in it).
  if (typeof err?.name === 'string' && err.name.startsWith('AI_')) {
    console.error(`llm error ${err.name}: ${String(err.message).slice(0, 300)}`);
    return res.status(502).json({ name: 'LLM_ERROR', message: String(err.message).slice(0, 500), details: { type: err.name } });
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    console.error(`timeout: ${String(err.message).slice(0, 200)}`);
    return res.status(504).json({ name: 'LLM_TIMEOUT', message: 'The language model did not answer in time. Try again.' });
  }
  if (err?.code === '23505') {
    return res.status(409).json({ name: 'DUPLICATE', message: err.detail ?? 'Already exists.' });
  }
  if (err?.code === '22P02') {
    return res.status(400).json({ name: 'INVALID_REQUEST', message: 'Malformed id or value.' });
  }
  // Unknown error: log the message only (no request bodies), return a generic 500.
  console.error('unhandled error:', err?.message ?? err);
  return res.status(500).json({ name: 'INTERNAL_SERVER_ERROR', message: 'Unexpected error.' });
};
