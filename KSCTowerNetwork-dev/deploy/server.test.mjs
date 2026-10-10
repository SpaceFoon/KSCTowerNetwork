import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productionEnvironment } from './server.mjs';

test('private env preserves quoted JSON and forces production without inheriting dev mode', () => {
  const env = productionEnvironment('APP_JWT_SECRET=example-test-secret-long-enough\nWEB_LOGIN_USERS_JSON=\'[{"passwordHash":"$argon2id$v=19$test"}]\'\n', { NODE_ENV: 'development', PATH: 'test-path' });
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.PATH, 'test-path');
  assert.equal(JSON.parse(env.WEB_LOGIN_USERS_JSON)[0].passwordHash, '$argon2id$v=19$test');
});

test('server rejects a development env file and unconfigured JWT template', () => {
  assert.throws(() => productionEnvironment('NODE_ENV=development\nAPP_JWT_SECRET=example-test-secret'), /production/);
  assert.throws(() => productionEnvironment('APP_JWT_SECRET=CHANGE_ME_TO_RANDOM'), /APP_JWT_SECRET/);
  assert.throws(() => productionEnvironment(''), /APP_JWT_SECRET/);
});
