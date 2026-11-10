import { CaseDetail } from './CaseDetail';
import { CasesGrid } from './CasesGrid';
import { AttentionList, ExposureWidget, Kpis, RecoveredByAgent } from './Overview';
import { Reputation } from './Reputation';
import { Scorecard } from './Scorecard';

export const PAGES = ['overview', 'cases', 'case', 'agents', 'scorecard'] as const;
export type PageId = (typeof PAGES)[number];

/** Custom AG Studio widgets. Each reads the Recourse API itself; none takes a data mapping. */
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
  def('rc-kpis', 'Recourse overview', Kpis, 'Headline numbers: agent purchases, open cases, confirmed recoveries, pending settlement, exposure, estimated dispute costs avoided.'),
  def('rc-attention', 'Needs a decision', AttentionList, 'Cases waiting for a human: assessment, ruling approval, operator acceptance or settlement.'),
  def('rc-recovered-by-agent', 'Recovered by agent version', RecoveredByAgent, 'Confirmed recoveries grouped by agent version.'),
  def('rc-exposure', 'Operator exposure', ExposureWidget, 'Liability caps used and remaining per operator agreement.'),
  def('rc-cases', 'Cases', CasesGrid, 'All cases with agent, operator, verdict, evidence and settlement status.'),
  def('rc-case', 'Case', CaseDetail, 'One case: what was authorised, what happened, and the conclusion, with its settlement.'),
  def('rc-reputation', 'Agents and operators', Reputation, 'Agent reliability and merchant policy; operator accountability.'),
  def('rc-scorecard', 'Scorecard', Scorecard, 'Accuracy of the assessment model on the fixed test cases.'),
];
