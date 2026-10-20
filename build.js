// Builds the single-file Code.gs that is pasted into the Apps Script editor
// from the modules in src/, in the order listed in src/ORDER.txt.
//   node build.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const SEP = '// ' + '='.repeat(70) + '\n';
const HEADER = '// Mimeon alpha — єдиний файл Code.gs (збірка з src/*.gs). НЕ редагуйте вручну: змінюйте src/ і збирайте знову (node build.js).\n';

const order = fs.readFileSync(path.join(SRC, 'ORDER.txt'), 'utf8').split('\n').filter(Boolean);
const parts = order.map(function (name) {
  return '\n' + SEP + '// ' + name + '\n' + SEP + fs.readFileSync(path.join(SRC, name), 'utf8');
});

fs.writeFileSync(path.join(__dirname, 'Code.gs'), HEADER + parts.join(''));
console.log('Code.gs built from ' + order.length + ' modules');
