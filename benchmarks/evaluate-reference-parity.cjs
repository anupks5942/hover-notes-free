#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const helpersPath = path.join(__dirname, '../sidebar/note-synthesis.js');
const benchmarkPath = path.join(__dirname, 'fixtures/dsa-lecture-00-08.json');
const vm = require('node:vm');

global.window = {};
vm.runInThisContext(fs.readFileSync(helpersPath, 'utf8'), { filename: 'sidebar/note-synthesis.js' });
const h = window.HoverNotesNoteSynthesis;
const benchmark = JSON.parse(fs.readFileSync(benchmarkPath, 'utf8'));

function evaluate(markdown) {
  const text = String(markdown || '').trim();
  const words = (text.match(/\b[\p{L}\p{N}_'-]+\b/gu) || []).length;
  const style = h.measureReferenceStyle(text);
  const bulletTotal = style.hyphenBullets + style.asteriskBullets;
  const hyphenRatio = bulletTotal ? style.hyphenBullets / bulletTotal : 1;

  const groups = benchmark.coverageGroups.map(group => {
    const hits = group.signals.filter(pattern => new RegExp(pattern, 'i').test(text));
    return {
      id: group.id,
      label: group.label,
      hits: hits.length,
      required: group.minimumHits,
      passed: hits.length >= group.minimumHits,
      matchedSignals: hits
    };
  });

  const expectations = benchmark.styleExpectations;
  const styleChecks = [
    ['topic headings', style.topicHeadings >= expectations.minimumTopicHeadings, `${style.topicHeadings} >= ${expectations.minimumTopicHeadings}`],
    ['no timestamp-led headings', style.timestampHeadings <= expectations.maximumTimestampHeadings, `${style.timestampHeadings} <= ${expectations.maximumTimestampHeadings}`],
    ['nested hyphen bullets', style.nestedHyphenBullets >= expectations.minimumNestedHyphenBullets, `${style.nestedHyphenBullets} >= ${expectations.minimumNestedHyphenBullets}`],
    ['bold concept callouts', style.boldCallouts >= expectations.minimumBoldCallouts, `${style.boldCallouts} >= ${expectations.minimumBoldCallouts}`],
    ['Mermaid diagrams', style.mermaidDiagrams >= expectations.minimumMermaidDiagrams, `${style.mermaidDiagrams} >= ${expectations.minimumMermaidDiagrams}`],
    ['display equations', style.displayEquations >= expectations.minimumDisplayEquations, `${style.displayEquations} >= ${expectations.minimumDisplayEquations}`],
    ['hyphen bullet ratio', hyphenRatio >= expectations.minimumHyphenBulletRatio, `${hyphenRatio.toFixed(2)} >= ${expectations.minimumHyphenBulletRatio}`],
    ['word count lower bound', words >= expectations.minimumWords, `${words} >= ${expectations.minimumWords}`],
    ['word count upper bound', words <= expectations.maximumWords, `${words} <= ${expectations.maximumWords}`]
  ].map(([label, passed, observed]) => ({ label, passed, observed }));

  const passedGroups = groups.filter(group => group.passed).length;
  const passedStyleChecks = styleChecks.filter(check => check.passed).length;
  const result = {
    benchmarkId: benchmark.benchmarkId,
    sourceInterval: benchmark.sourceInterval,
    words,
    coverage: { passed: passedGroups, total: groups.length, percentage: Math.round(100 * passedGroups / groups.length) },
    style: { passed: passedStyleChecks, total: styleChecks.length, metrics: { ...style, hyphenBulletRatio: Number(hyphenRatio.toFixed(3)) } },
    passed: passedGroups === groups.length && passedStyleChecks === styleChecks.length,
    failedCoverageGroups: groups.filter(group => !group.passed),
    failedStyleChecks: styleChecks.filter(check => !check.passed),
    coverageGroups: groups,
    styleChecks
  };
  return result;
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node benchmarks/evaluate-reference-parity.cjs <generated-note.md>');
    process.exit(2);
  }
  const markdown = fs.readFileSync(path.resolve(file), 'utf8');
  const result = evaluate(markdown);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}

module.exports = { evaluate, benchmark };
