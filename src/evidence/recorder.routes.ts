import { Router } from 'express';
import { z } from 'zod';
import { db } from '../shared/db/pool';
import { HttpError, route } from '../shared/http/errors';
import { uuidParam } from '../shared/http/ids';
import { appendEntry, listCheckpoints, listEntries, verifyChain } from './recorder';
import { checkSnapshot } from './snapshots';

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

/** GET /recorder/:case_ref: entries and signed checkpoints, in order. */
recorder.get(
  '/:case_ref',
  route(async (req, res) => {
    const ref = caseRef(req.params.case_ref);
    res.json({ case_ref: ref, entries: await listEntries(ref), checkpoints: await listCheckpoints(ref) });
  }),
);

/** POST /recorder/:case_ref/entries { kind, payload }: append one entry (and sign a checkpoint). */
recorder.post(
  '/:case_ref/entries',
  route(async (req, res) => {
    const ref = caseRef(req.params.case_ref);
    const body = AppendBody.parse(req.body);
    res.status(201).json(await appendEntry(ref, body.kind, body.payload));
  }),
);

/** GET /recorder/:case_ref/verify: chain and checkpoint check; reports the first problem by seq. */
recorder.get(
  '/:case_ref/verify',
  route(async (req, res) => {
    const ref = caseRef(req.params.case_ref);
    const [entries, checkpoints] = [await listEntries(ref), await listCheckpoints(ref)];
    if (!entries.length && !checkpoints.length) throw new HttpError(404, 'RESOURCE_NOT_FOUND', `No recorder entries for case ${ref}`);
    res.json(verifyChain(ref, entries, checkpoints));
  }),
);

/** GET /catalog-snapshots/:id: a stored snapshot, re-hashed to show it is unchanged. */
export const snapshots = Router();
snapshots.get(
  '/:id',
  route(async (req, res) => {
    const id = uuidParam(req.params.id, 'Catalog snapshot');
    const check = await checkSnapshot(id);
    if (!check) throw new HttpError(404, 'RESOURCE_NOT_FOUND', `Catalog snapshot ${id} not found`);
    const { rows } = await db().query('SELECT catalog_version, snapshot, created_at FROM catalog_snapshots WHERE id = $1', [id]);
    res.json({ ...check, catalog_version: rows[0].catalog_version, first_stored_at: rows[0].created_at, snapshot: rows[0].snapshot });
  }),
);
