import { CaseDetail } from './CaseDetail';
import { CasesGrid } from './CasesGrid';
import { AttentionList } from './Overview';
import { Reputation } from './Reputation';
import { Scorecard } from './Scorecard';
import { Settlements } from './Settlements';

export const PAGES = ['overview', 'cases', 'case', 'agents', 'settlements', 'scorecard'] as const;
export type PageId = (typeof PAGES)[number];

/** Custom AG Studio widgets for the screens that need Recourse's own logic (the overview's tiles, chart and exposure
 *  grid are AG Studio's built-in widgets on the Studio data tables). Each reads the Recourse API itself. */
const def = (id: string, label: string, comp: any, description: string, size = { width: 900, height: 500 }) => ({
  id,
  label,
  comp,
  form: (params: any) => params.createDefaults({ dataMappingItems: [] }),
  defaultSize: size,
  minSize: { width: 320, height: 160 },
  ai: { description },
});

export const WIDGETS = [
  def('rc-attention', 'Needs a decision', AttentionList, 'Cases waiting for a human: assessment, decision approval, operator acceptance or settlement.'),
  def('rc-cases', 'Cases', CasesGrid, 'All cases with agent, operator, finding, evidence and settlement status.'),
  def('rc-case', 'Case', CaseDetail, 'One case: what was authorised, what happened, and the conclusion, with its settlement.'),
  def('rc-reputation', 'Agents and operators', Reputation, 'Agent reliability and merchant policy; operator accountability.'),
  def('rc-settlements', 'Settlements', Settlements, 'Every settlement obligation with its PayPal actions, ids and confirmation.'),
  def('rc-scorecard', 'Scorecard', Scorecard, 'Accuracy of the assessment model on the fixed test cases.'),
];
