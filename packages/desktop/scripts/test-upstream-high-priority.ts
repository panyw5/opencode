import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const sanitizer = `/@fs${resolve(import.meta.dir, "../../ui/src/components/markdown-sanitize.ts")}`
  const rows = `/@fs${resolve(import.meta.dir, "../../app/src/pages/session/timeline/rows.ts")}`
  const result = await cdp.evaluate<{
    sanitized: number
    rows: number
    median: number
    legacyMedian: number
  }>(`(async () => {
    const { createMarkdownSanitizer } = await import(${JSON.stringify(sanitizer)});
    const { TimelineRow } = await import(${JSON.stringify(rows)});
    const source = await (await fetch(${JSON.stringify(rows)})).text();
    const effectUrl = source.match(/from "([^"]*effect[^\"]+)"/)?.[1];
    if (!effectUrl) throw new Error('Effect dependency URL not found');
    const { Equal } = await import(effectUrl);
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const sanitize = createMarkdownSanitizer(window);
    const payload = '<h2>Heading</h2><math><mi>x</mi></math><svg><path d="M0 0"/></svg>' +
      '<p data-source-line="3">safe</p><script>alert(1)</script><style>body{display:none}</style>' +
      '<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a>';
    for (let i = 0; i < 100; i++) {
      const safe = sanitize(payload);
      check(safe.includes('<h2>Heading</h2>') && safe.includes('<math>') && safe.includes('<svg>'), 'lost HTML/math/SVG');
      check(safe.includes('data-source-line="3"'), 'lost Markdown anchor');
      check(!/<script|<style|onerror|javascript:|display:none/.test(safe), 'unsafe sanitized content');
    }
    const makeRows = () => Array.from({ length: 1319 }, (_, i) => new TimelineRow.AssistantPart({
      userMessageID: 'u' + Math.floor(i / 4), previousAssistantPart: i % 4 !== 0,
      group: { type: 'context', key: 'g' + i, refs: Array.from({ length: 3 }, (_, j) => ({ messageID: 'a' + i, partID: 'p' + j })) }
    }));
    const previous = makeRows();
    const sample = (compare) => {
      const timings = [];
      for (let run = 0; run < 60; run++) {
        const next = makeRows();
        const start = performance.now();
        check(next.every((row, i) => compare(previous[i], row)), 'unchanged row failed equality');
        if (run >= 10) timings.push(performance.now() - start);
      }
      return timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)];
    };
    const legacyMedian = sample(Equal.equals);
    const median = sample(TimelineRow.equals);
    console.debug('[upstream-port] sanitizer=100 rows=1319 equality-ms=' + median.toFixed(3) + ' legacy-ms=' + legacyMedian.toFixed(3));
    return { sanitized: 100, rows: previous.length, median, legacyMedian };
  })()`)
  assert.equal(result.sanitized, 100)
  assert.equal(result.rows, 1319)
  console.log(
    `[upstream-port] PASS Chromium sanitization iterations=${result.sanitized} rows=${result.rows} median=${result.median.toFixed(3)}ms legacy=${result.legacyMedian.toFixed(3)}ms`,
  )
})
