import { createHash } from 'node:crypto';
import fs from 'node:fs';

// Local compatibility patch for the exact shipped OneCLI 1.42 bundle.
// Fail on another build: compiled symbol names are not a stable upstream API.
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const digest = createHash('sha256').update(source).digest('hex');
if (digest !== '7edbcaea38357d4c988f64269ddcbd088639646854fe152f0e28ca6c22cae35f') {
  throw new Error('Unexpected OneCLI bundle; review the workspace patch for this version');
}
const start = source.indexOf('p4=()=>JSON.stringify(');
const end = source.indexOf(',p3=JSON.stringify', start);
if (start < 0 || end < start) throw new Error('Codex stub factory seam changed');
const original = source.slice(start + 3, end);
const replacement = `p4=e=>{const t=JSON.parse((${original})());if(typeof e==="string"&&e.trim()&&e!=="onecli-managed"){t.tokens.account_id=e;const r=t.tokens.id_token.split(".");const i=JSON.parse(Buffer.from(r[1],"base64url").toString("utf8"));i["https://api.openai.com/auth"].chatgpt_account_id=e;r[1]=Buffer.from(JSON.stringify(i)).toString("base64url");t.tokens.id_token=r.join(".")}return JSON.stringify(t,null,2)}`;
let patched = source.slice(0, start) + replacement + source.slice(end);
function replaceOnce(before, after) {
  if (patched.split(before).length !== 2) throw new Error(`OneCLI call-site seam changed: ${before}`);
  patched = patched.replace(before, after);
}
replaceOnce('content:p4()', 'content:p4(u?.accountId)');
replaceOnce('content:i?p3:p4()', 'content:i?p3:p4(gE(r.find(e=>gE(e.metadata)?.authMode==="oauth")?.metadata)?.accountId)');
// Only account metadata changes; the original dummy token values stay intact.
fs.writeFileSync(file, patched);
console.log('Patched OneCLI Codex stub factory and both stub endpoints.');
