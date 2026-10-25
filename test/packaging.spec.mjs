/**
 * Packaging receipts: what the *published* artifact needs, asserted at test time.
 *
 * Every failure below is silent — the suite is green, the build is green, and
 * the consumer gets a package that cannot load or a dependency that cannot
 * resolve. That is the only reason these live in the test suite rather than in a
 * release checklist.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

function walk(dir, extensions, found = []) {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, extensions, found)
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(path)
  }
  return found
}

/**
 * Bare specifiers reached by `import`/`export from`, dynamic `import()`, and
 * `require()` in one source text. Relative targets and `node:` builtins are not
 * installable packages and are dropped here rather than per call site.
 */
function bareSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /(?:^|[\s;{])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;(=])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;{])import\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...specifiers].filter((specifier) =>
    !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:'))
}

function packageOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

const runtimeDeclared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
])
const devDeclared = new Set(Object.keys(manifest.devDependencies ?? {}))

const sourceFiles = [...walk(join(ROOT, 'src'), ['.ts']), ...walk(join(ROOT, 'lib'), ['.js'])]
const imported = new Set()
for (const file of sourceFiles) {
  for (const specifier of bareSpecifiers(readFileSync(file, 'utf8'))) imported.add(packageOf(specifier))
}

test('the receipt has something to guard', () => {
  assert.ok(sourceFiles.some((file) => file.includes(join('src', 'index.ts'))), 'src/index.ts must be scanned')
  assert.ok(sourceFiles.some((file) => file.endsWith(join('lib', 'index.js'))), 'lib/index.js must be built and scanned')
  assert.ok(imported.size >= 3, `expected several bare imports, saw ${imported.size}`)
})

test('every bare import in the shipped code is declared as a runtime dependency', () => {
  const undeclared = [...imported].filter((name) => !runtimeDeclared.has(name))
  assert.deepEqual(undeclared, [],
    `imported by shipped code but not declared at runtime: ${undeclared.join(', ')} — a consumer gets ERR_MODULE_NOT_FOUND`)
})

test('no runtime dependency is declared without being imported', () => {
  const unused = [...runtimeDeclared].filter((name) => !imported.has(name))
  assert.deepEqual(unused, [], `declared but never imported by shipped code: ${unused.join(', ')}`)
})

test('test-only packages stay out of the runtime closure', () => {
  const allowed = new Set(Object.keys(manifest.peerDependencies ?? {}))
  const leaked = [...devDeclared].filter((name) => runtimeDeclared.has(name) && !allowed.has(name))
  assert.deepEqual(leaked, [], `a devDependency also declared at runtime: ${leaked.join(', ')}`)
})

test('the shipped file list carries the mount the harness reads', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch file must be in `files`')
  assert.ok(existsSync(join(ROOT, 'cordis.patch.yml')), 'and must exist')
})

test('the entry point ships with the repository, not only with a local build', () => {
  // A git install carries tracked files only, and `lib/` is build output: if it
  // is ignored, `dsh plugin add` attaches a package whose `main` does not exist
  // and the profile mounts nothing while reporting success.
  assert.ok(manifest.files.includes('lib/index.js'), 'the built entry must be in `files`')
  assert.ok(existsSync(join(ROOT, 'lib/index.js')), 'and must exist (run the build)')

  // Both channels have an ignore file that decides what travels: `.gitignore`
  // for a git install, `.npmignore` for a tarball. Neither is required to be
  // present — a measured copy of this tree carries no ignore file, and one that
  // is absent cannot hide anything.
  const rules = ['.gitignore', '.npmignore']
    .filter((name) => existsSync(join(ROOT, name)))
    .flatMap((name) => readFileSync(join(ROOT, name), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => `${name}: ${line}`))
  const hidingLibrary = rules.filter((rule) => /^\.\w*ignore: \/?lib(\/|$)/.test(rule))
  assert.deepEqual(hidingLibrary, [],
    `no ignore file may hide lib/: ${hidingLibrary.join(', ')} — that channel would ship no entry point`)
})
