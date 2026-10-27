// Builds the prebuilt "AI safety & agent risks" view: fixed questions -> public/safety.json.
// Usage: ANTHROPIC_API_KEY=... node scripts/safety.js
import { writeFile } from 'node:fs/promises';
import { ask } from '../lib/s1.js';

const TOPICS = [
  ['Models behaving in unintended ways', 'What does the filing say about the risk of its AI models behaving in unintended, deceptive, or harmful ways?'],
  ['Catastrophic risk', 'What does the filing say about catastrophic or severe risks from sufficiently advanced AI systems?'],
  ['Autonomous agents', 'What risks does the filing describe from AI agents taking actions autonomously?'],
  ['Who is liable for agent actions', 'What does the filing say about legal liability for actions taken autonomously by AI systems?'],
  ['Misuse: cyber and bio', 'What does the filing say about misuse of AI for cyberattacks or biological harm?'],
  ['Responsible Scaling Policy', 'What does the filing say about the Responsible Scaling Policy and what happens if a model triggers enhanced safety measures?'],
  ['Safety vs. revenue', 'Does the filing say its safety commitments could slow model releases or hurt revenue?'],
  ['Long-Term Benefit Trust', 'What power does the Long-Term Benefit Trust have over the company, and why does it exist?'],
];

const out = [];
for (const [topic, question] of TOPICS) {
  const r = await ask(question);
  console.log(`${r.answerable ? 'ok ' : 'n/a'} ${r.quotes.length}q ${r.dropped} dropped  ${topic}`);
  out.push({ topic, question, ...r });
}
await writeFile('public/safety.json', JSON.stringify({ built: new Date().toISOString().slice(0, 10), topics: out }, null, 1));
