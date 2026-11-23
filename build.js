#!/usr/bin/env node
// Builds a minified copy of the game:  node build.js  ->  dist/index.html
//
// index.html stays the readable source. Nothing here changes what is drawn:
// shaders only lose comments/whitespace and get shorter names, and the script
// goes through terser. Needs Node and network access the first time (npx
// fetches terser).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, 'index.html');
const OUT_DIR = path.join(__dirname, 'dist');
const OUT = path.join(OUT_DIR, 'index.html');
const TERSER = 'terser@5.36.0';
const BUDGET = 100 * 1000;

// ---------------------------------------------------------------- split page
const html = fs.readFileSync(SRC, 'utf8');
const cut = (open, close) => {
  const a = html.indexOf(open), b = html.lastIndexOf(close);
  if (a < 0 || b < 0) throw new Error(`Could not find ${open} … ${close}`);
  return [a, a + open.length, b, b + close.length];
};
const [styleA, styleIn, styleOut, styleB] = cut('<style>', '</style>');
const [scriptA, scriptIn, scriptOut, scriptB] = cut('<script>', '</script>');
const head = html.slice(0, styleA);
const css = html.slice(styleIn, styleOut);
const body = html.slice(styleB, scriptA);
let js = html.slice(scriptIn, scriptOut);
const tail = html.slice(scriptB);

// ------------------------------------------------------------ shader minifier
const GLSL_RESERVED = new Set(`
attribute const uniform varying buffer shared coherent volatile restrict readonly writeonly
layout centroid flat smooth noperspective patch sample break continue do for while switch case default
if else subroutine in out inout float double int void bool true false invariant precise discard return
mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4
vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 uint uvec2 uvec3 uvec4
lowp mediump highp precision struct
sampler2D sampler3D samplerCube sampler2DShadow samplerCubeShadow sampler2DArray sampler2DArrayShadow
isampler2D isampler3D isamplerCube isampler2DArray usampler2D usampler3D usamplerCube usampler2DArray
radians degrees sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh
pow exp log exp2 log2 sqrt inversesqrt abs sign floor trunc round roundEven ceil fract mod modf
min max clamp mix step smoothstep isnan isinf floatBitsToInt floatBitsToUint intBitsToFloat uintBitsToFloat
packSnorm2x16 unpackSnorm2x16 packUnorm2x16 unpackUnorm2x16 packHalf2x16 unpackHalf2x16
length distance dot cross normalize faceforward reflect refract
matrixCompMult outerProduct transpose determinant inverse
lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual any all not
textureSize texture textureProj textureLod textureOffset texelFetch texelFetchOffset textureProjOffset
textureLodOffset textureProjLod textureProjLodOffset textureGrad textureGradOffset textureProjGrad
textureProjGradOffset dFdx dFdy fwidth
main es version define undef ifdef ifndef elif endif error pragma extension line defined
asm class union enum typedef template this packed goto inline noinline public static extern external
interface long short half fixed unsigned superp input output hvec2 hvec3 hvec4 dvec2 dvec3 dvec4
fvec2 fvec3 fvec4 sampler1D sampler1DShadow sampler2DRect sizeof cast namespace using
`.trim().split(/\s+/));

const GLSL_TOKEN = new RegExp([
  '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)',                                  // 1 comment
  '(^[ \\t]*#[^\\n]*)',                                                      // 2 preprocessor line
  '(0[xX][0-9a-fA-F]+[uU]?|(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?[uUfF]?)', // 3 number
  '([A-Za-z_]\\w*)',                                                         // 4 identifier
  '(\\+\\+|--|<<=?|>>=?|[<>=!+\\-*\\/%&|^]=|&&|\\|\\||\\^\\^|[{}()\\[\\];,.=+\\-*\\/<>!&|?:^%~])', // 5 punctuation
  '(\\s+)',                                                                  // 6 whitespace
].join('|'), 'gmy');

function tokenizeGLSL(src) {
  const out = [];
  GLSL_TOKEN.lastIndex = 0;
  let pos = 0, m;
  while (pos < src.length) {
    GLSL_TOKEN.lastIndex = pos;
    m = GLSL_TOKEN.exec(src);
    if (!m) throw new Error('GLSL tokenizer stuck at: ' + JSON.stringify(src.slice(pos, pos + 40)));
    pos = GLSL_TOKEN.lastIndex;
    if (m[1] || m[6]) continue;
    if (m[2]) out.push({ t: 'pp', v: m[2].trim().replace(/\s+/g, ' ') });
    else if (m[3]) out.push({ t: 'num', v: m[3] });
    else if (m[4]) out.push({ t: 'id', v: m[4] });
    else out.push({ t: 'p', v: m[5] });
  }
  return out;
}

function shortNumber(n) {
  const m = /^(\d+)\.(\d+)$/.exec(n);
  if (!m) return n;
  const i = m[1].replace(/^0+/, ''), f = m[2].replace(/0+$/, '');
  return i || f ? `${i}.${f}` : '0.';
}

function* nameGenerator() {
  const first = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const rest = first + '0123456789';
  for (const c of first) yield c;
  for (const c of first) for (const d of rest) yield c + d;
  for (const c of first) for (const d of rest) for (const e of rest) yield c + d + e;
}

/** Minifies a set of shaders together so shared names (varyings, uniforms) stay in sync. */
function minifyShaders(sources) {
  const tokenSets = sources.map(tokenizeGLSL);
  const fields = new Set();
  const counts = new Map();
  const renamable = (tok, prev) =>
    tok.t === 'id' && !GLSL_RESERVED.has(tok.v) && !tok.v.startsWith('gl_') &&
    (!(prev && prev.v === '.') || fields.has(tok.v));

  for (const toks of tokenSets) {
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].v !== 'struct') continue;
      let j = i + 2;
      if (toks[j].v !== '{') throw new Error('Unexpected struct syntax');
      for (j++; toks[j].v !== '}'; j++) {
        if (toks[j].t === 'id' && toks[j + 1].t === 'p' && /^[;,\[]$/.test(toks[j + 1].v)) fields.add(toks[j].v);
      }
    }
  }
  for (const f of fields) {
    if (/^([xyzw]+|[rgba]+|[stpq]+)$/.test(f)) throw new Error(`Struct field "${f}" looks like a swizzle`);
  }
  for (const toks of tokenSets) {
    toks.forEach((tok, i) => {
      if (renamable(tok, toks[i - 1])) counts.set(tok.v, (counts.get(tok.v) || 0) + 1);
    });
  }

  const names = nameGenerator();
  const rename = new Map();
  for (const [id] of [...counts].sort((a, b) => b[1] - a[1])) {
    let n;
    do { n = names.next().value; } while (GLSL_RESERVED.has(n));
    rename.set(id, n);
  }

  const uniforms = new Map();
  const outputs = tokenSets.map((toks) => {
    let out = '', prev = null;
    toks.forEach((tok, i) => {
      let v = tok.v;
      if (tok.t === 'pp') {
        out += (out && !out.endsWith('\n') ? '\n' : '') + v + '\n';
        prev = null;
        return;
      }
      if (tok.t === 'num') v = shortNumber(v);
      else if (renamable(tok, toks[i - 1])) v = rename.get(v);
      if (prev) {
        const wordy = (t) => t.t === 'id' || t.t === 'num';
        const a = out[out.length - 1], b = v[0];
        if ((wordy(prev) && wordy(tok)) || ((a === '+' || a === '-') && a === b)) out += ' ';
      }
      out += v;
      prev = tok;
    });
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].v !== 'uniform') continue;
      let j = i + 1;
      while (toks[j].t === 'id' && toks[j + 1].t === 'id') j++; // skip precision + type
      for (; toks[j].v !== ';'; j++) {
        if (toks[j].t === 'id' && rename.has(toks[j].v) && toks[j - 1].v !== '[') uniforms.set(toks[j].v, rename.get(toks[j].v));
      }
    }
    return out;
  });
  return { outputs, uniforms };
}

// ------------------------------------------- pull shaders out of the script
// Numeric constants that shaders interpolate, e.g. ${MAX_MOBS}.
const numericConsts = new Map();
for (const m of js.matchAll(/^const ([A-Z_0-9]+) = (-?[\d.]+);/gm)) numericConsts.set(m[1], m[2]);

const isGLSL = (text) => /\b(void main|uniform|vec[234])\b/.test(text) && !/<svg|<div/.test(text);
const literals = [];
for (const m of js.matchAll(/`[^`]*`/g)) {
  if (isGLSL(m[0])) literals.push({ start: m.index, end: m.index + m[0].length, text: m[0].slice(1, -1) });
}
const namedLiteral = new Map();
for (const lit of literals) {
  const decl = /const (\w+) = $/.exec(js.slice(Math.max(0, lit.start - 80), lit.start));
  if (decl) namedLiteral.set(decl[1], lit);
}
const resolve = (text, depth = 0) => text.replace(/\$\{(\w+)\}/g, (_, name) => {
  if (numericConsts.has(name)) return numericConsts.get(name);
  if (namedLiteral.has(name) && depth < 4) return resolve(namedLiteral.get(name).text, depth + 1);
  throw new Error(`Cannot resolve \${${name}} inside a shader`);
});

// Full programs get minified; fragments that are only spliced into others are dropped.
const programs = literals.filter((l) => l.text.trimStart().startsWith('#version'));
const snippets = literals.filter((l) => !programs.includes(l));
const { outputs, uniforms } = minifyShaders(programs.map((p) => resolve(p.text)));
const glslBefore = literals.reduce((n, l) => n + l.text.length, 0);
const glslAfter = outputs.reduce((n, o) => n + o.length, 0);

const replacements = [
  ...programs.map((p, i) => ({ ...p, with: '`' + outputs[i] + '`' })),
  ...snippets.map((s) => ({ ...s, with: '``' })),
].sort((a, b) => b.start - a.start);

// Rename uniform lookups on the script side, outside the shader text.
const uniformRe = new RegExp(`([.'"])(${[...uniforms.keys()].join('|')})\\b`, 'g');
const renameUniforms = (code) => code.replace(uniformRe, (_, lead, name) => lead + uniforms.get(name));
let cursor = js.length, rebuilt = '';
for (const r of replacements) {
  rebuilt = r.with + renameUniforms(js.slice(r.end, cursor)) + rebuilt;
  cursor = r.start;
}
js = renameUniforms(js.slice(0, cursor)) + rebuilt;

// Inline SVG markup built in the script: drop whitespace between tags.
js = js.replace(/`[^`]*<svg[^`]*`/g, (m) => m.replace(/>\s+</g, '><'));

// --------------------------------------------------------------- script pass
// Property names that are also used as plain strings (lookup keys such as
// monster types and key codes) must keep their names.
const noShaders = js.replace(/`#version[^`]*`/g, '``');
const stringNames = new Set();
for (const m of noShaders.matchAll(/'([A-Za-z_$][\w$]*)'|"([A-Za-z_$][\w$]*)"/g)) stringNames.add(m[1] || m[2]);
// Option names handed to browser APIs (WebGL context attributes) that terser's
// built-in list does not know about.
const BROWSER_OPTION_NAMES = ['antialias', 'alpha', 'depth', 'stencil', 'powerPreference'];
const uniformKeys = [...uniforms.values()].flatMap((u) => [u, `${u}[0]`]);
const reserved = [...new Set([...stringNames, ...uniformKeys, ...BROWSER_OPTION_NAMES, '__game'])];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'torchlight-build-'));
const tmpIn = path.join(tmp, 'in.js'), tmpOut = path.join(tmp, 'out.js'), tmpCfg = path.join(tmp, 'cfg.json');
const tmpCache = path.join(tmp, 'names.json');
fs.writeFileSync(tmpIn, js);
fs.writeFileSync(tmpCfg, JSON.stringify({
  compress: { passes: 3 },
  mangle: { properties: { reserved } },
  format: { comments: false },
}));
execFileSync('npx', ['--yes', TERSER, tmpIn, '--config-file', tmpCfg, '--name-cache', tmpCache, '-o', tmpOut], { stdio: 'inherit' });
const minJs = fs.readFileSync(tmpOut, 'utf8').trim();
if (minJs.includes('</script')) throw new Error('Minified script contains </script');
if (process.argv.includes('--names')) {
  const cache = JSON.parse(fs.readFileSync(tmpCache, 'utf8'));
  console.log(Object.keys(cache.props.props).map((k) => k.slice(1)).sort().join(' '));
}
fs.rmSync(tmp, { recursive: true, force: true });

// ------------------------------------------------------------- CSS and HTML
const minCss = css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .replace(/ ?([{};]) ?/g, '$1')
  .replace(/([:,]) /g, '$1')
  .replace(/;}/g, '}')
  .trim();
const squeeze = (markup) => markup.replace(/>\s+</g, '><').replace(/\s+/g, ' ').replace(/ \/>/g, '/>').trim();

const result = `${squeeze(head)}<style>${minCss}</style>${squeeze(body)}<script>${minJs}</script>${squeeze(tail)}\n`;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, result);

const kb = (n) => (n / 1000).toFixed(1) + ' kB';
const size = Buffer.byteLength(result);
console.log(`shaders  ${kb(glslBefore)} -> ${kb(glslAfter)}`);
console.log(`script   ${kb(Buffer.byteLength(html.slice(scriptIn, scriptOut)))} -> ${kb(Buffer.byteLength(minJs))} (shaders included)`);
console.log(`total    ${kb(Buffer.byteLength(html))} -> ${kb(size)}  (${(size / 1024).toFixed(1)} KiB)`);
if (size >= BUDGET) {
  console.error(`Over the ${kb(BUDGET)} budget by ${kb(size - BUDGET)}`);
  process.exit(1);
}
