const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluate, benchmark } = require('../benchmarks/evaluate-reference-parity.cjs');

const golden = fs.readFileSync(path.join(__dirname, '../benchmarks/fixtures/dsa-lecture-00-08-golden.md'), 'utf8');
const goldResult = evaluate(golden);
assert.equal(goldResult.passed, true, 'the curated 00:00–08:00 benchmark note should satisfy all content and style checks');
assert.equal(goldResult.coverage.percentage, 100);
assert.equal(goldResult.style.passed, goldResult.style.total);
assert.equal(goldResult.style.metrics.timestampHeadings, 0);
assert.equal(goldResult.style.metrics.mermaidDiagrams, 1);
assert.equal(goldResult.style.metrics.displayEquations, 1);

const chronologicalDraft = `### [00:00] Course Introduction\n* The course covers the syllabus.\n\n### [01:00] DSA\n* DSA is important.\n\n### [02:00] Algorithms\n* Algorithms solve problems.`;
const rejected = evaluate(chronologicalDraft);
assert.equal(rejected.passed, false, 'a timestamp-led, flat, incomplete incremental draft must fail the benchmark');
assert.ok(rejected.failedCoverageGroups.length > 0);
assert.ok(rejected.failedStyleChecks.length > 0);

assert.equal(benchmark.sourceInterval.endSeconds, 480, 'the benchmark is limited to the matching first eight minutes');
console.log('Reference parity benchmark passes the curated gold note and rejects a representative chronological/incomplete draft.');
