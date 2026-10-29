'use strict';
const assert = require('assert');
const { slugify } = require('./slugify');

assert.strictEqual(slugify('Hello, World!'), 'hello-world');
assert.strictEqual(slugify('  a  b  '), 'a-b');
assert.strictEqual(slugify(''), '');
console.log('ok');
