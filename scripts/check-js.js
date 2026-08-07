// Batch `node --check` for all js files under src/. Exits 1 on any syntax error.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const files = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && e.name.endsWith('.js')) files.push(p);
    }
})(SRC);

let bad = 0;
for (const f of files) {
    try {
        execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (err) {
        bad++;
        console.error(`[FAIL] ${path.relative(process.cwd(), f)}`);
        console.error(String(err.stderr || err.message));
    }
}
console.log(`[check-js] ${files.length} js files, ${bad} errors`);
process.exit(bad ? 1 : 0);
