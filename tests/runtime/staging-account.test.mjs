// The browser collaboration flow must carry the identity that actually signed in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secondAccount } from '../../tools/staging/client.mjs';

for (const emailOnly of [false, true]) {
  test(`second account retains its ${emailOnly ? 'email' : 'legacy username'} identifier`, async () => {
    const original = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_url, request) => {
      requests.push(JSON.parse(request.body));
      const refused = emailOnly && requests.length === 1;
      return new Response(JSON.stringify(refused ? { error: { code: 'UNAUTHORIZED' } } : { username: 'public_member' }), {
        status: refused ? 401 : 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'session=fixture; HttpOnly' },
      });
    };
    try {
      const member = await secondAccount('https://fixture.invalid', { KIT_USERNAME: 'fixture', KIT_PASSWORD: 'local-fixture-password' });
      assert.equal(member.identifier, emailOnly ? 'delivered+fixture_m@resend.dev' : 'fixture_m');
      assert.equal(member.name, 'public_member');
      assert.equal(member.session.cookie, 'session=fixture');
      assert.equal(member.session.origin, 'https://fixture.invalid/api/v1');
      assert.equal(requests.at(-1).username, member.identifier);
    } finally {
      globalThis.fetch = original;
    }
  });
}
