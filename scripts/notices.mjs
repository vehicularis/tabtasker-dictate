// Rewrites the library half of THIRD_PARTY_NOTICES.txt: every Rust crate compiled into the app, every npm
// package the pages can bundle and the bundled fonts, each with the licence text it ships. The model notices
// above the marker are written by hand and kept as they are. Run after changing a dependency:
//   node scripts/notices.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MARKER = '==== Libraries and fonts inside TabTasker Dictate ====';
const FILE = new URL('../THIRD_PARTY_NOTICES.txt', import.meta.url).pathname;
const ROOT = dirname(FILE);

// What `cargo build --release` links on a Mac: normal dependencies only, never dev or build ones.
const meta = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', join(ROOT, 'Cargo.toml'), '--format-version', '1', '--offline', '--filter-platform', 'aarch64-apple-darwin'], { maxBuffer: 1 << 28 }));
const nodes = new Map(meta.resolve.nodes.map(node => [node.id, node]));
const linked = new Set(), stack = meta.packages.filter(pkg => pkg.name === 'tabtasker-dictate').map(pkg => pkg.id);
while (stack.length) {
  const id = stack.pop();
  if (linked.has(id)) continue;
  linked.add(id);
  for (const dep of nodes.get(id).deps) if (dep.dep_kinds.some(kind => kind.kind === null)) stack.push(dep.pkg);
}
const crates = meta.packages.filter(pkg => linked.has(pkg.id) && !meta.workspace_members.includes(pkg.id));

// A dual licence offers a choice; MIT is the one shipped when it is offered.
const filesOf = dir => readdirSync(dir).filter(name => /^(licen[cs]e|copying|notice)/i.test(name)).sort();
const pick = (files, licence) => {
  const mit = files.filter(name => /mit/i.test(name));
  return /\bMIT\b/.test(licence ?? '') && mit.length ? mit : files;
};
const entries = [
  ...crates.map(pkg => ({ name: `${pkg.name} ${pkg.version}`, licence: pkg.license ?? pkg.license_file ?? 'see text', dir: dirname(pkg.manifest_path), url: pkg.repository })),
  // Every npm package the pages can bundle: package-lock's installed packages that are not dev-only
  // (`dev`, `devOptional`), the build tools left out the same way the Rust build dependencies are.
  ...Object.entries(JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages)
    .filter(([path, entry]) => path.startsWith('node_modules/') && !entry.dev && !entry.devOptional)
    .map(([path]) => {
      const dir = join(ROOT, path), pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const url = (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url)?.replace(/^git\+/, '') ?? pkg.homepage;
      return { name: `${pkg.name} ${pkg.version} (npm)`, licence: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type, dir, url };
    }),
  { name: 'Source Sans 3 (font)', licence: 'OFL-1.1', dir: join(ROOT, 'public/fonts'), files: ['source-sans-3-LICENSE.txt'], url: 'https://github.com/adobe-fonts/source-sans' },
  { name: 'Stack Sans Headline (font)', licence: 'OFL-1.1', dir: join(ROOT, 'public/fonts'), files: ['stack-sans-headline-LICENSE.txt'], url: 'https://github.com/DylanYoungKoto/Stack-Sans' },
];

// One copy of each distinct text, with every package that ships it.
const texts = new Map();
for (const entry of entries) {
  const files = entry.files ?? pick(filesOf(entry.dir), entry.licence);
  const text = files.map(name => readFileSync(join(entry.dir, name), 'utf8').replace(/\r\n/g, '\n').trim()).join('\n\n')
    || `Licensed under ${entry.licence}. No licence file ships with this package; see ${entry.url ?? 'its repository'}.`;
  const group = texts.get(text) ?? [];
  group.push(entry);
  texts.set(text, group);
}
const blocks = [...texts].sort(([, a], [, b]) => a[0].name.localeCompare(b[0].name)).map(([text, group]) =>
  `${group.map(entry => `${entry.name}: ${entry.licence}${entry.url ? `, ${entry.url}` : ''}`).join('\n')}\n\n${text}`);

const before = readFileSync(FILE, 'utf8');
const at = before.indexOf(MARKER);
const head = (at < 0 ? before : before.slice(0, at)).trimEnd();
writeFileSync(FILE, `${head}\n\n${MARKER}\n\n${blocks.join('\n\n----\n\n')}\n`);
console.log(`${entries.length} packages, ${texts.size} licence texts`);
