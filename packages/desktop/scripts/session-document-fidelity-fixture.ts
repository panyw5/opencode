import { withCdp } from "./cdp"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

const folder = process.env.SESSION_EXPORT_TEST_DIR
if (!folder) throw new Error("SESSION_EXPORT_TEST_DIR is required")
const html = await withCdp((client) =>
  client.evaluate<string>(`(async () => {
  const {shareHTML} = await import('/@fs/Users/lelouch/apps/opencode/packages/app/src/components/session/session-share-html.ts?t='+Date.now());
  const root = document.createElement('div');
  root.className = 'session-share-paper';
  root.style.cssText = 'position:fixed;left:-10000px;top:0;width:600px;background:white;color:black;content-visibility:visible';
  const sample = document.querySelector('[data-component="markdown"]');
  if (!sample) throw new Error('No real Markdown sample');
  root.append(sample.cloneNode(true));
  const fixture = document.createElement('div');
  fixture.innerHTML = '<pre><code><span style="color:rgb(210,30,60)">const</span> x = 1;</code></pre><a data-file-link><svg data-file-link-icon style="width:16px;height:16px"><symbol id="fixture-file" viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></symbol><use href="#fixture-file"/></svg>file.ts</a>';
  root.append(fixture);
  const math = document.querySelector('.katex');
   if (!math) throw new Error('No real KaTeX sample');
   for (let index = 0; index < 28; index++) {
     const message = document.createElement('section');
     message.setAttribute('data-test-message', String(index + 1));
     message.append(document.createTextNode('Mathematical message '+(index+1)+': '), sample.cloneNode(true), math.cloneNode(true));
     root.append(message);
   }
  const tail = document.createElement('div');
  tail.style.cssText = 'height:6000px;background:rgb(0,220,0)';
  root.append(tail);
  document.body.append(root);
  try {
    await document.fonts.ready;
     const nodes = [root, ...root.querySelectorAll('*')];
     const inlineStyleBytes = nodes.reduce((bytes, node) => bytes + new TextEncoder().encode(Array.from(getComputedStyle(node)).filter(key => !key.startsWith('--') && !/^(animation|transition)/.test(key)).map(key => key+':'+getComputedStyle(node).getPropertyValue(key)+';').join('')).length, 0);
     console.log('[fidelity-test] messages=28 math='+root.querySelectorAll('.katex').length+' nodes='+nodes.length+' baseline-inline-style-bytes='+inlineStyleBytes);
     const html = await shareHTML(root,'light');
     return '<!-- baseline-inline-style-bytes='+inlineStyleBytes+' messages=28 math='+root.querySelectorAll('.katex').length+' nodes='+nodes.length+' -->'+html;
  } finally { root.remove(); }
})()`),
)
await writeFile(join(folder, "snapshot.html"), html)
console.log(`[fidelity-test] snapshot bytes=${Buffer.byteLength(html)}`)
