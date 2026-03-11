/**
 * Type definitions for the Backlog Intelligence Engine.
 */

export interface TicketData {
  key: string;
  summary: string;
  description: string;
  issueType: string;
  priority: string;
  storyPoints: number | null;
  labels: string[];
  components: string[];
  status: string;
  assignee: string | null;
  created: string;
  updated: string;
  resolutionDate: string | null;
  changelog: ChangelogItem[];
}

export interface ChangelogItem {
  field: string;
  from: string | null;
  to: string | null;
  timestamp: string;
}

export interface TeamRule {
  category: string;
  rule_key: string;
  issue_type: string | null;
  rule_value: string;
  confidence: number;
  sample_size: number;
}

export interface QualityScore {
  total: number;
  description: number;
  metadata: number;
  process: number;
}

export interface AnalysisResult {
  rules: TeamRule[];
  totalTickets: number;
  qualityPassed: number;
  qualityFailed: number;
  avgQualityScore: number;
  rulesByCategory: Record<string, number>;
}
