/** One bounded page of the recorded commits explaining selected UTC chart buckets. */
export type ContributionItem = {
  repo: string;
  name: string;
  commit: string;
  subject: string;
  at: number;
};
export type ContributionDetails = {
  items: ContributionItem[];
  total: number;
  cursors: Record<string, string | null>;
  partial?: boolean;
};
