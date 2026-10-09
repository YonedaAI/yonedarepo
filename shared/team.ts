/** Frozen validated implementation plan. Indexes refer to the submitted run agent roster. */
export interface TeamPlan {
  version: 1;
  contract: string;
  integrator_agent: number;
  integration_paths: string[];
  tasks: TeamTaskPlan[];
}
export interface TeamTaskPlan {
  id: string;
  title: string;
  instructions: string;
  agent: number;
  depends_on: string[];
  write_paths: string[];
}
export type RunMode = 'compare' | 'collaborate';
