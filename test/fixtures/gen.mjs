// Regenerate the e2e audio fixtures (gitignored: *.mp3).
// Run after npm i:  node test/fixtures/gen.mjs
import audio from 'audio';
import fs from 'fs';
import path from 'path';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// 3s mono sine @440Hz, 44.1kHz — the workhorse fixture
let sr = 44100, n = 3 * sr;
let ch = new Float32Array(n);
for (let i = 0; i < n; i++) ch[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.5;
let bytes = await audio.from([ch], sr).encode('mp3');
fs.writeFileSync(path.join(dir, 'sine-3s.mp3'), Buffer.from(bytes));

// decode-error fixtures
fs.writeFileSync(path.join(dir, 'bad.mp3'), Buffer.from('not an audio file at all, just garbage bytes'));
fs.writeFileSync(path.join(dir, 'empty.mp3'), Buffer.alloc(0));

console.log('fixtures written to', dir);
