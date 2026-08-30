/**
 * Static guard: a name exported as `ns.X` must never be *called* bare in a file
 * that neither declares it nor destructures it from `ns`.
 *
 * Field failure: `message-router.js` called `buildCacheKeyVariants(lookupUrl)`
 * inside `buildCacheLookupCandidates`, but the name was never added to the
 * file's `const { ... } = ns` block. It only exists as `ns.buildCacheKeyVariants`
 * (module-local in cache-keys.js), so every call threw
 * `ReferenceError: buildCacheKeyVariants is not defined`.
 *
 * It survived 17 commits because the throw sits on a cold-looking branch — it
 * fires only after the first IndexedDB pass misses — and the lookup handler's
 * catch turned it into an ordinary "miss". The whole miss-recovery chain
 * (bridge wait, inflight-prefetch collapse, inflight-write collapse, playlist
 * recovery) was dead, and the rollup reported it as a cache hit-rate problem.
 *
 * `node --check` cannot catch this: a free identifier is a runtime error, not a
 * syntax error. Nothing else in the suite loads a background file and walks its
 * branches, so this check is what stands between us and the next one.
 *
 * Run: node test/background/static/ns-export-binding.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")

const SRC = path.join(__dirname, "../../../src/background")

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith(".js")) out.push(full)
  }
  return out
}

const files = walk(SRC)
const sources = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]))

// Strip comments and string/template literals so text inside them cannot be
// mistaken for code — log lines mention these names constantly.
//
// Hand-rolled scanner, not a regex. A regex for template literals cannot track
// `${ }` nesting: the first attempt used `\$\{[^}]*\}` and any interpolation
// containing an object literal or a nested template desynced it, swallowing
// hundreds of lines of real code and reporting three false positives on
// functions that were declared in plain sight.
function stripNonCode(src) {
  const out = []
  let i = 0
  // Context stack. "tmpl" = raw template text (skipped); "expr" = the code
  // inside a `${ }` interpolation (kept), carrying its own brace depth so the
  // interpolation's closing brace is not confused with an object literal's.
  const stack = []
  const top = () => (stack.length ? stack[stack.length - 1] : null)

  const prevMeaningful = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const c = out[k]
      if (c !== " " && c !== "\n" && c !== "\t") return c
    }
    return ""
  }

  while (i < src.length) {
    const ctx = top()

    if (ctx?.type === "tmpl") {
      const c = src[i]
      if (c === "\\") { i += 2; continue }
      if (c === "`") { stack.pop(); out.push("`"); i++; continue }
      if (c === "$" && src[i + 1] === "{") {
        stack.push({ type: "expr", depth: 0 })
        out.push(" ")
        i += 2
        continue
      }
      if (c === "\n") out.push("\n")
      i++
      continue
    }

    const c = src[i]
    const next = src[i + 1]

    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++
      out.push(" ")
      continue
    }
    if (c === "/" && next === "*") {
      i += 2
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out.push("\n")
        i++
      }
      i += 2
      out.push(" ")
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      i++
      while (i < src.length && src[i] !== quote) i += src[i] === "\\" ? 2 : 1
      i++
      out.push(quote, quote)
      continue
    }
    if (c === "`") { stack.push({ type: "tmpl" }); out.push("`"); i++; continue }
    if (c === "{") { if (ctx?.type === "expr") ctx.depth++; out.push(c); i++; continue }
    if (c === "}") {
      if (ctx?.type === "expr") {
        // Depth 0 means this brace closes the interpolation, not a block.
        if (ctx.depth === 0) { stack.pop(); out.push(" "); i++; continue }
        ctx.depth--
      }
      out.push(c)
      i++
      continue
    }
    // Regex literal, so a quote or backtick inside a character class cannot
    // desync the scanner. A `/` starts one only where a value may begin.
    if (c === "/" && /[(,=:[!&|?{};+\-*%~^<>]|^$/.test(prevMeaningful())) {
      i++
      let inClass = false
      while (i < src.length) {
        const r = src[i]
        if (r === "\\") { i += 2; continue }
        if (r === "[") inClass = true
        else if (r === "]") inClass = false
        else if (r === "/" && !inClass) break
        else if (r === "\n") break
        i++
      }
      i++
      out.push(" ")
      continue
    }
    out.push(c)
    i++
  }
  return out.join("")
}

// Every name the background bundle publishes on the shared namespace.
const exported = new Set()
for (const src of sources.values()) {
  const code = stripNonCode(src)
  for (const m of code.matchAll(/\bns\.([A-Za-z_$][\w$]*)\s*=/g)) exported.add(m[1])
}

function declaredIn(code, name) {
  const n = name.replace(/[$]/g, "\\$")
  // Declared: function/class/const/let/var, or destructured from ns (possibly
  // renamed: `{ foo: bar }`), or a function parameter with that name.
  if (new RegExp(`\\b(?:function\\s*\\*?|class)\\s+${n}\\b`).test(code)) return true
  if (new RegExp(`\\b(?:const|let|var)\\s+${n}\\b`).test(code)) return true
  // Destructuring block(s) assigned from the namespace under any of the spellings
  // the codebase uses for it. Matching only `= ns` reported service-worker.js,
  // which destructures from `self.AegisBackground` directly.
  const NS_RHS = /(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*(?:ns|(?:self|globalThis)\.AegisBackground)\b/g
  for (const m of code.matchAll(NS_RHS)) {
    const names = m[1].split(",").map((s) => s.split(":").pop().split("=")[0].trim())
    if (names.includes(name)) return true
  }
  // Bound as a parameter or catch/for binding.
  if (new RegExp(`[({,]\\s*${n}\\s*[,)=]`).test(code)) return true
  return false
}

const violations = []
for (const [file, src] of sources) {
  const code = stripNonCode(src)
  for (const name of exported) {
    // A bare call: `name(` not preceded by `.` (member access) and not part of
    // a longer identifier.
    const call = new RegExp(`(^|[^\\w$.])${name.replace(/[$]/g, "\\$")}\\s*\\(`, "m")
    if (!call.test(code)) continue
    if (declaredIn(code, name)) continue
    violations.push({ file: path.relative(SRC, file), name })
  }
}

if (violations.length > 0) {
  console.error("Bare calls to ns-exported names that are neither declared nor destructured:\n")
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.name}(...) — add it to the \`const { ... } = ns\` block, or call it as ns.${v.name}(...)`)
  }
  console.error(
    `\n${violations.length} violation(s). Each throws ReferenceError the first time that line runs.`
  )
  process.exit(1)
}

console.log(`  scanned ${files.length} background files, ${exported.size} ns exports: OK`)
console.log("ns-export-binding.test.js: OK")
