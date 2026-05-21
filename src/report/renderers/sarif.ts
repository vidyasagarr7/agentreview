import type { ConsolidatedReport, AgentFinding, FindingSeverity } from '../../types/index.js';

function deduplicateRules(findings: AgentFinding[]): SarifRule[] {
  const seen = new Map<string, SarifRule>();
  for (const f of findings) {
    if (!seen.has(f.id)) {
      seen.set(f.id, {
        id: f.id,
        shortDescription: { text: f.summary },
        fullDescription: { text: f.detail },
        help: { text: f.suggestion, markdown: f.suggestion },
        defaultConfiguration: { level: mapSeverity(f.severity) },
        properties: {
          tags: f.lenses,
          category: f.category,
          severity: f.severity,
        },
      });
    }
  }
  return [...seen.values()];
}

// ─── SARIF 2.1.0 Type Subset ─────────────────────────────────────────────────

interface SarifMessage {
  text: string;
  markdown?: string;
}

interface SarifArtifactLocation {
  uri: string;
}

interface SarifRegion {
  startLine: number;
}

interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region: SarifRegion;
}

interface SarifLocation {
  physicalLocation: SarifPhysicalLocation;
}

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: SarifMessage;
  locations: SarifLocation[];
  properties: Record<string, unknown>;
}

interface SarifRule {
  id: string;
  shortDescription: SarifMessage;
  fullDescription: SarifMessage;
  help: SarifMessage;
  defaultConfiguration: { level: 'error' | 'warning' | 'note' };
  properties: Record<string, unknown>;
}

interface SarifToolDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}

interface SarifInvocation {
  executionSuccessful: boolean;
  properties: Record<string, unknown>;
}

interface SarifRun {
  tool: { driver: SarifToolDriver };
  results: SarifResult[];
  invocations: SarifInvocation[];
}

interface SarifLog {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map AgentReview severity to SARIF level. */
export function mapSeverity(severity: FindingSeverity): 'error' | 'warning' | 'note' {
  switch (severity) {
    case 'CRITICAL':
    case 'HIGH':
      return 'error';
    case 'MEDIUM':
      return 'warning';
    case 'LOW':
    case 'INFO':
      return 'note';
  }
}

/** Parse "file.ts:42" into { file, line }. */
export function parseLocation(location: string): { file: string; line: number } {
  const match = location.match(/^(.+?)(?::(\d+))?$/);
  if (!match) return { file: location, line: 1 };
  return { file: match[1], line: parseInt(match[2] ?? '1', 10) };
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

export function renderSarif(report: ConsolidatedReport): string {
  const sarifLog: SarifLog = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'AgentReview',
          version: '1.0.0',
          informationUri: 'https://github.com/vidyasagarr7/agentreview',
          rules: deduplicateRules(report.findings),
        },
      },
      results: report.findings.map((f) => {
        const loc = parseLocation(f.location);
        return {
          ruleId: f.id,
          level: mapSeverity(f.severity),
          message: { text: `${f.summary}\n\n${f.detail}\n\nSuggestion: ${f.suggestion}` },
          locations: [{
            physicalLocation: {
              artifactLocation: { uri: loc.file },
              region: { startLine: loc.line },
            },
          }],
          properties: {
            category: f.category,
            severity: f.severity,
            confidence: f.confidenceScore,
            lenses: f.lenses,
          },
        };
      }),
      invocations: [{
        executionSuccessful: true,
        properties: {
          pr: `${report.pr.repoOwner}/${report.pr.repoName}#${report.pr.number}`,
          reviewedAt: report.reviewedAt,
        },
      }],
    }],
  };

  return JSON.stringify(sarifLog, null, 2);
}
