'use strict';

const { fetchFirstValidJson } = require('../scripts/fetch-json');

let failures = 0;
function ok(condition, message) {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message);
  if (!condition) failures++;
}

(async () => {
  const requested = [];
  const body = await fetchFirstValidJson(['primary', 'mirror'], async url => {
    requested.push(url);
    return url === 'primary' ? '<html><h1>temporary error</h1></html>' : '{"pokemon":{}}';
  });

  ok(body === '{"pokemon":{}}', 'uses the mirror when a successful response is not JSON');
  ok(requested.join(',') === 'primary,mirror', 'validates the primary before accepting it');

  let error;
  try {
    await fetchFirstValidJson(['one', 'two'], async url => url === 'one' ? '<html>' : 'not json');
  } catch (caught) {
    error = caught;
  }
  ok(error && /no source returned valid JSON/.test(error.message), 'fails clearly when every source is invalid');

  if (failures) process.exit(1);
  console.log('\nfetch-json tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
