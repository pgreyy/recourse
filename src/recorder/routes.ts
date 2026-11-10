import { Router } from 'express';
import { z } from 'zod';
import { HttpError, route } from '../http/errors';
import { appendEntry, listEntries, verifyChain } from './recorder';

export const recorder = Router();

const CaseRef = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/, 'letters, digits and . _ : - only');
const AppendBody = z.object({
  kind: z.string().trim().min(1).max(100),
  payload: z.unknown().refine((v) => v !== undefined, 'payload is required'),
});

function caseRef(raw: string): string {
  const r = CaseRef.safeParse(raw);
  if (!r.success) throw new HttpError(400, 'INVALID_REQUEST', `case_ref ${r.error.issues[0].message}`);
  return r.data;
}

/** GET /recorder/:case_ref: every entry in order. */
recorder.get(
  '/:case_ref',
  route(async (req, res) => {
    const ref = caseRef(req.params.case_ref);
    res.json({ case_ref: ref, entries: await listEntries(ref) });
  }),
);

/** POST /recorder/:case_ref/entries { kind, payload }: append one entry. */
recorder.post(
  '/:case_ref/entries',
  route(async (req, res) => {
    const ref = caseRef(req.params.case_ref);
    const body = AppendBody.parse(req.body);
    res.status(201).json(await appendEntry(ref, body.kind, body.payload));
  }),
);

/** GET /recorder/:case_ref/verify: walk the chain, report the first broken seq if any. */
recorder.get(
  '/:case_ref/verify',
  route(async (req, res) => {
    const ref = caseRef(req.params.case_ref);
    const entries = await listEntries(ref);
    if (!entries.length) throw new HttpError(404, 'RESOURCE_NOT_FOUND', `No recorder entries for case ${ref}`);
    res.json(verifyChain(ref, entries));
  }),
);
