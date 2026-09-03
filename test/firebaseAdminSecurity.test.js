const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

test('frontend contains no Firebase client SDK or service-account credential path', () => {
  for (const tree of ['client/src', 'src']) {
    const base = path.join(root, tree);
    const files = [];
    const visit = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(target);
        else files.push(target);
      }
    };
    visit(base);
    const source = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
    assert.doesNotMatch(source, /firebase\/(app|firestore)|BEGIN PRIVATE KEY|private_key|serviceAccount/);
    assert.equal(fs.existsSync(path.join(base, 'firebaseClient.js')), false);
  }
  const clientPackage = JSON.parse(fs.readFileSync(path.join(root, 'client/package.json'), 'utf8'));
  assert.equal(clientPackage.dependencies.firebase, undefined);
});

test('service-account files are excluded from Git', () => {
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(gitignore, /firebase-service-account\.json/);
  assert.match(gitignore, /\*service-account\*\.json/);
});

test('accounts API exposes password presence but never returns account passwords', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = server.indexOf("app.get('/api/accounts'");
  const end = server.indexOf("app.post('/api/accounts'", start);
  const route = server.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(route, /hasPassword/);
  assert.doesNotMatch(route, /password:\s*a\.password|res\.json\(accounts\)/);
});
