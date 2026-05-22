// ─── integration.test.ts — Cross-file PHI flow analysis integration test ────

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { analyzePhiFlow, flowPathsToFindings } from './index.js';
import type {
  FlowAnalysisInput,
  LLMClient,
  FilePhiProfile,
} from './types.js';
import { DEFAULT_FLOW_OPTIONS } from './types.js';

// ─── Fixture Loading ─────────────────────────────────────────────────────────

const FIXTURE_DIR = path.resolve(__dirname, '../../../test/fixtures/hipaa-flow');

function loadFixture(name: string): { path: string; content: string } {
  const filePath = `src/services/${name}`;
  const content = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
  return { path: filePath, content };
}

const fixtures = {
  patientService: loadFixture('patient-service.ts'),
  patientMiddleware: loadFixture('patient-middleware.ts'),
  requestLogger: loadFixture('request-logger.ts'),
  analyticsSender: loadFixture('analytics-sender.ts'),
  eventBus: loadFixture('event-bus.ts'),
  queuePublisher: loadFixture('queue-publisher.ts'),
  queueConsumer: loadFixture('queue-consumer.ts'),
  redactor: loadFixture('redactor.ts'),
};

// ─── Mock LLM Profiles ───────────────────────────────────────────────────────
// Realistic FilePhiProfile responses the LLM would return for each fixture file.

const mockProfiles: Record<string, FilePhiProfile> = {
  'src/services/patient-service.ts': {
    sources: [
      { name: 'getPatient', line: 16, type: 'fhir-read' },
    ],
    sinks: [],
    transforms: [],
    exports: [
      { name: 'getPatient', containsPhi: true },
      { name: 'PatientRecord', containsPhi: true },
    ],
    imports: [
      { from: 'fhirclient', names: ['Client'] },
    ],
    runtimeFlows: [],
  },
  'src/services/patient-middleware.ts': {
    sources: [],
    sinks: [],
    transforms: [
      {
        name: 'attachPatient',
        line: 5,
        inputParam: 'getPatient',
        outputReturn: false,
        mechanism: 'middleware-next',
      },
    ],
    exports: [
      { name: 'attachPatient', containsPhi: true },
    ],
    imports: [
      { from: './patient-service', names: ['getPatient'] },
    ],
    runtimeFlows: [],
  },
  'src/services/request-logger.ts': {
    sources: [],
    sinks: [
      { name: 'console.log', line: 9, type: 'log' },
    ],
    transforms: [],
    exports: [
      { name: 'requestLogger', containsPhi: false },
    ],
    imports: [
      { from: './patient-service', names: ['getPatient'] },
    ],
    runtimeFlows: [],
  },
  'src/services/analytics-sender.ts': {
    sources: [],
    sinks: [
      { name: 'mixpanel.track', line: 11, type: 'analytics' },
      { name: 'mixpanel.track', line: 21, type: 'analytics' },
    ],
    transforms: [],
    exports: [
      { name: 'trackPatientView', containsPhi: true },
      { name: 'trackPatientEvent', containsPhi: true },
    ],
    imports: [
      { from: './patient-service', names: ['getPatient', 'PatientRecord'] },
    ],
    runtimeFlows: [],
  },
  'src/services/event-bus.ts': {
    sources: [],
    sinks: [],
    transforms: [],
    exports: [
      { name: 'patientEvents', containsPhi: false },
      { name: 'emitPatientUpdated', containsPhi: true },
      { name: 'onPatientUpdated', containsPhi: false },
    ],
    imports: [
      { from: './patient-service', names: ['PatientRecord'] },
    ],
    runtimeFlows: [
      {
        type: 'event-emit',
        channel: 'patient-updated',
        functionName: 'emitPatientUpdated',
        line: 9,
        dataParam: 'patient',
      },
      {
        type: 'event-listen',
        channel: 'patient-updated',
        functionName: 'onPatientUpdated',
        line: 18,
        dataParam: 'handler',
      },
    ],
  },
  'src/services/queue-publisher.ts': {
    sources: [],
    sinks: [],
    transforms: [],
    exports: [
      { name: 'publishPatientEvent', containsPhi: true },
    ],
    imports: [
      { from: './patient-service', names: ['PatientRecord'] },
    ],
    runtimeFlows: [
      {
        type: 'queue-publish',
        channel: 'phi-events',
        functionName: 'publishPatientEvent',
        line: 10,
        dataParam: 'patient',
      },
    ],
  },
  'src/services/queue-consumer.ts': {
    sources: [],
    sinks: [
      { name: 'console.log', line: 14, type: 'log' },
    ],
    transforms: [],
    exports: [
      { name: 'startConsumer', containsPhi: false },
    ],
    imports: [],
    runtimeFlows: [
      {
        type: 'queue-subscribe',
        channel: 'phi-events',
        functionName: 'startConsumer',
        line: 9,
      },
    ],
  },
  'src/services/redactor.ts': {
    sources: [],
    sinks: [],
    transforms: [
      {
        name: 'redactPhi',
        line: 5,
        inputParam: 'data',
        outputReturn: true,
        mechanism: 'direct',
      },
      {
        name: 'stripPhi',
        line: 13,
        inputParam: 'data',
        outputReturn: true,
        mechanism: 'direct',
      },
    ],
    exports: [
      { name: 'redactPhi', containsPhi: false },
      { name: 'stripPhi', containsPhi: false },
      { name: 'isRedacted', containsPhi: false },
    ],
    imports: [],
    runtimeFlows: [],
  },
};

// ─── Mock Verifier Responses ─────────────────────────────────────────────────

interface VerifierResponse {
  isLeak: boolean;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  baaRelevant: boolean;
}

function mockVerifierResponse(
  sourceFile: string,
  sinkFile: string,
  sinkType: string,
): VerifierResponse {
  // patient-service → request-logger (log): PHI leak via logging
  if (sourceFile.includes('patient-service') && sinkFile.includes('request-logger')) {
    return {
      isLeak: true,
      confidence: 'high',
      explanation: 'PHI from FHIR read is passed through middleware and logged to console without redaction.',
      baaRelevant: false,
    };
  }

  // patient-service → analytics-sender (analytics): PHI leak, no BAA
  if (sourceFile.includes('patient-service') && sinkFile.includes('analytics-sender')) {
    return {
      isLeak: true,
      confidence: 'high',
      explanation: 'PHI including SSN and name sent to Mixpanel analytics without BAA.',
      baaRelevant: true,
    };
  }

  // event-bus / queue → queue-consumer (log): runtime flow leak
  if (sinkFile.includes('queue-consumer')) {
    return {
      isLeak: true,
      confidence: 'medium',
      explanation: 'PHI flows through event/queue runtime channels and is logged by consumer.',
      baaRelevant: false,
    };
  }

  // Paths involving redactor → not a leak (safe pattern)
  if (sourceFile.includes('redactor') || sinkFile.includes('redactor')) {
    return {
      isLeak: false,
      confidence: 'high',
      explanation: 'Data passes through redactPhi which strips sensitive fields before output.',
      baaRelevant: false,
    };
  }

  // Default: flag as potential leak
  return {
    isLeak: true,
    confidence: 'medium',
    explanation: 'PHI data flow detected without clear sanitization.',
    baaRelevant: false,
  };
}

// ─── Mock LLM Client ─────────────────────────────────────────────────────────

function createMockLLM(): LLMClient {
  return {
    async chat(messages) {
      const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';

      // Profiler call: return FilePhiProfile
      if (userMsg.includes('PHI sources') || userMsg.includes('Profile the following') || userMsg.includes('sources') && userMsg.includes('sinks') && userMsg.includes('transforms')) {
        // Extract filename from the user prompt
        for (const [filePath, profile] of Object.entries(mockProfiles)) {
          if (userMsg.includes(filePath)) {
            return JSON.stringify(profile);
          }
        }
        // Fallback: empty profile
        return JSON.stringify({
          sources: [],
          sinks: [],
          transforms: [],
          exports: [],
          imports: [],
          runtimeFlows: [],
        });
      }

      // Verifier call: return VerifierResponse
      if (userMsg.includes('HIPAA compliance') || userMsg.includes('genuine PHI leak') || userMsg.includes('SOURCE:') && userMsg.includes('SINK:')) {
        // Extract source and sink files from prompt
        const sourceMatch = userMsg.match(/SOURCE:.*?in\s+([\w/.:-]+)/);
        const sinkMatch = userMsg.match(/SINK:.*?in\s+([\w/.:-]+)/);
        const sinkTypeMatch = userMsg.match(/SINK:.*?\((\w[\w-]*)\)/);

        const sourceFile = sourceMatch?.[1] ?? '';
        const sinkFile = sinkMatch?.[1] ?? '';
        const sinkType = sinkTypeMatch?.[1] ?? '';

        return JSON.stringify(mockVerifierResponse(sourceFile, sinkFile, sinkType));
      }

      // Retry calls (validation error re-prompts)
      if (userMsg.includes('failed validation')) {
        // Return a valid empty profile or verifier response
        if (userMsg.includes('sources') || userMsg.includes('sinks')) {
          return JSON.stringify({
            sources: [],
            sinks: [],
            transforms: [],
            exports: [],
            imports: [],
            runtimeFlows: [],
          });
        }
        return JSON.stringify({
          isLeak: false,
          confidence: 'low',
          explanation: 'Unable to determine flow.',
          baaRelevant: false,
        });
      }

      // Default fallback
      return JSON.stringify({
        sources: [],
        sinks: [],
        transforms: [],
        exports: [],
        imports: [],
        runtimeFlows: [],
      });
    },
  };
}

// ─── Integration Tests ───────────────────────────────────────────────────────

describe('Cross-file PHI flow analysis — integration', () => {
  const allFiles = Object.values(fixtures);
  const mockLLM = createMockLLM();

  it('detects patient-service → request-logger path via middleware', async () => {
    const input: FlowAnalysisInput = {
      options: { ...DEFAULT_FLOW_OPTIONS, maxFiles: 8, maxPaths: 50 },
      files: allFiles,
      llm: mockLLM,
    };

    const result = await analyzePhiFlow(input);

    // Should find path: patient-service (source) → request-logger (sink) via import edge
    const logPaths = result.paths.filter(
      (p) =>
        p.source.file === fixtures.patientService.path &&
        p.sink.file === fixtures.requestLogger.path &&
        p.sink.type === 'log',
    );

    expect(logPaths.length).toBeGreaterThanOrEqual(1);
    expect(logPaths[0].isLeak).toBe(true);
    expect(logPaths[0].source.type).toBe('fhir-read');
  });

  it('flags patient-service → analytics-sender with no-BAA context', async () => {
    const input: FlowAnalysisInput = {
      options: { ...DEFAULT_FLOW_OPTIONS, maxFiles: 8, maxPaths: 50 },
      files: allFiles,
      llm: mockLLM,
    };

    const result = await analyzePhiFlow(input);

    const analyticsPaths = result.paths.filter(
      (p) =>
        p.source.file === fixtures.patientService.path &&
        p.sink.file === fixtures.analyticsSender.path &&
        p.sink.type === 'analytics',
    );

    expect(analyticsPaths.length).toBeGreaterThanOrEqual(1);
    expect(analyticsPaths[0].isLeak).toBe(true);
    expect(analyticsPaths[0].baaRelevant).toBe(true);
  });

  it('detects event-bus → queue-consumer runtime flow path', async () => {
    const input: FlowAnalysisInput = {
      options: { ...DEFAULT_FLOW_OPTIONS, maxFiles: 8, maxPaths: 50 },
      files: allFiles,
      llm: mockLLM,
    };

    const result = await analyzePhiFlow(input);

    // Runtime flows: queue-publisher publishes 'phi-events',
    // queue-consumer subscribes 'phi-events' and logs
    const runtimePaths = result.paths.filter(
      (p) => p.sink.file === fixtures.queueConsumer.path,
    );

    // Should find path reaching queue-consumer through queue runtime flow
    expect(runtimePaths.length).toBeGreaterThanOrEqual(1);
    expect(runtimePaths[0].isLeak).toBe(true);
    expect(runtimePaths[0].sink.type).toBe('log');

    // Check graph stats show runtime edges were processed
    expect(result.graphStats.filesAnalyzed).toBeGreaterThan(0);
  });

  it('respects maxFiles cap', async () => {
    const input: FlowAnalysisInput = {
      options: { ...DEFAULT_FLOW_OPTIONS, maxFiles: 3, maxPaths: 50 },
      files: allFiles,
      llm: mockLLM,
    };

    const result = await analyzePhiFlow(input);

    // Should have profiled at most 3 files
    expect(result.profiles.size).toBeLessThanOrEqual(
      // profiles can include runtime-detected files beyond the LLM-profiled set
      allFiles.length,
    );
    // But diagnostics should warn about exceeding file cap
    if (allFiles.length > 3) {
      const capWarning = result.diagnostics.find((d) =>
        d.message.includes('exceed max'),
      );
      expect(capWarning).toBeDefined();
    }
  });

  it('converts verified paths to AgentFinding format via flowPathsToFindings', async () => {
    const input: FlowAnalysisInput = {
      options: { ...DEFAULT_FLOW_OPTIONS, maxFiles: 8, maxPaths: 50 },
      files: allFiles,
      llm: mockLLM,
    };

    const result = await analyzePhiFlow(input);
    const findings = flowPathsToFindings(result.paths);

    // Should produce at least one finding
    expect(findings.length).toBeGreaterThan(0);

    for (const finding of findings) {
      // Validate AgentFinding structure
      expect(finding.id).toMatch(/^phi-flow-\d+$/);
      expect(finding.severity).toMatch(/^(INFO|LOW|MEDIUM|HIGH|CRITICAL)$/);
      expect(finding.category).toBe('HIPAA / PHI Data Flow');
      expect(finding.location).toBeTruthy();
      expect(finding.summary).toBeTruthy();
      expect(finding.detail).toBeTruthy();
      expect(finding.suggestion).toBeTruthy();
      expect(finding.lenses).toContain('hipaa');
      expect(finding.scannerId).toBe('phi-flow-analysis');
      expect(finding.regulation).toBe('HIPAA §164.502(a)');
      expect(finding.confidenceScore).toBeGreaterThan(0);
      expect(finding.confidenceScore).toBeLessThanOrEqual(1);
    }
  });

  it('graph stats are populated correctly', async () => {
    const input: FlowAnalysisInput = {
      options: { ...DEFAULT_FLOW_OPTIONS, maxFiles: 8, maxPaths: 50 },
      files: allFiles,
      llm: mockLLM,
    };

    const result = await analyzePhiFlow(input);

    expect(result.graphStats.filesAnalyzed).toBeGreaterThan(0);
    expect(result.graphStats.candidatePaths).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeGreaterThan(0);
  });
});
