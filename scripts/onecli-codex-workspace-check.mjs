import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual factory from the shipped OneCLI bundle, not a mock.
const source = fs.readFileSync(process.argv[2], 'utf8');
const start = source.indexOf('p4=');
const end = source.indexOf(',p3=JSON.stringify', start);
assert.ok(start >= 0 && end > start, 'OneCLI Codex stub factory seam changed');
const factory = vm.runInNewContext(`(${source.slice(start + 3, end)})`, { Buffer, Date });
for (const accountId of ['workspace-personal-test', 'workspace-business-test']) {
  const stub = JSON.parse(factory(accountId));
  const claims = JSON.parse(Buffer.from(stub.tokens.id_token.split('.')[1], 'base64url'));
  assert.equal(stub.tokens.account_id, accountId);
  assert.equal(claims['https://api.openai.com/auth'].chatgpt_account_id, accountId);
  assert.equal(stub.tokens.access_token, 'onecli-managed');
  assert.equal(stub.tokens.refresh_token, 'onecli-managed');
  assert.equal(stub.OPENAI_API_KEY, null);
}
assert.equal(JSON.parse(factory()).tokens.account_id, 'onecli-managed');
assert.ok(source.includes('content:p4(u?.accountId)'), 'Container config must pass selected secret metadata');
console.log('OneCLI workspace stub checks passed; tokens remain placeholders.');
