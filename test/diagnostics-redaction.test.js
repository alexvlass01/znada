'use strict';

const assert = require('assert');
const { redactText, redactValue, looksSensitive } = require('../diagnostics/core/redaction');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  OK ' + name); passed++; };

ok('windows drive path is redacted', redactText('open C:\\Users\\alex\\Pictures\\37.png failed') === 'open <path> failed');
ok('forward-slash windows path is redacted', !looksSensitive(redactText('C:/Users/alex/wall.jpg')));
ok('UNC path is redacted', redactText('\\\\NAS\\photos\\a.png') === '<path>');
ok('posix home path is redacted', redactText('at /home/alex/.config/x') === 'at <path>');
ok('email is redacted', redactText('sent to alex@example.com now') === 'sent to <email> now');
ok('token assignment is redacted', redactText('api_key=abcd1234 and token: zzz') === '<token> and <token>');
ok('data uri is collapsed', redactText('img data:image/png;base64,AAAABBBBCCCC done').includes('<data-uri>')
  && !redactText('img data:image/png;base64,AAAABBBBCCCC done').includes('AAAA'));
ok('query string is dropped', redactText('https://api.example.com/v1/x?user=alex&token=zz').startsWith('https://api.example.com/v1/x')
  && !redactText('https://api.example.com/v1/x?user=alex').includes('alex'));

const deep = redactValue({ reason: 'TypeError', note: 'file C:\\Users\\alex\\a.png', nested: ['ok', 'mail me@x.io'], n: 5 });
ok('redactValue walks objects and arrays', deep.note === 'file <path>' && deep.nested[1] === 'mail <email>' && deep.n === 5);
ok('clean strings pass through untouched', redactText('frame-window maxMs 241.5') === 'frame-window maxMs 241.5');
ok('looksSensitive flags a raw path and clears a clean string',
  looksSensitive('C:\\Users\\alex') === true && looksSensitive('all clean here') === false);

console.log('\nAll ' + passed + ' diagnostics redaction tests passed.');
