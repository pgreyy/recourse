import { z } from 'zod';
import { notFound } from './errors';

const Uuid = z.string().uuid();

/** A path id that must be a uuid; anything else is a 404 rather than a database error. */
export function uuidParam(value: string, what: string): string {
  if (!Uuid.safeParse(value).success) throw notFound(what, value);
  return value;
}
