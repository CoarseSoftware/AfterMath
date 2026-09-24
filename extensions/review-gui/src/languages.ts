import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

/** TEMPORARY host-side diagnostics (hover/definition round-trip). Every
 *  step logs to %TEMP%/aftermath-debug.log so a runtime failure inside the
 *  extension host is visible without the dev console. Remove once the
 *  hover/definition issue is confirmed fixed. */
function dbg(msg: string): void {
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'aftermath-debug.log'), new Date().toISOString() + ' ' + msg + '\n');
  } catch {
    /* logging must never break the feature */
  }
}
export { dbg as dbgLog };
dbg('languages module loaded (typescript ' + (ts.version || '?') + ')');

// ---------------------------------------------------------------------------
// Hover type info + go-to-definition for the review webview.
//
// The extension API has no "give me the type at this position" endpoint
// (the editor's IntelliSense lives inside the workbench — the SCM diff gets
// it because it IS the built-in editor, not a webview). So the host runs
// the TypeScript compiler's LanguageService itself, scoped to the file under
// review plus its import graph (resolved exactly like `tsc` resolves it, so
// types from imported project files AND node_modules packages work).
//
// Only TypeScript/JavaScript files are supported; anything else returns
// null and the UI stays inert. The service is cached per repo root and
// torn down after 60 s of idleness (it holds its whole import graph).
// ---------------------------------------------------------------------------

export interface HoverInfo {
  /** One-line type signature, e.g. `const name: string` or
   *  `function load(x: number): Promise<void>` — what VS Code's hover shows. */
  kind: string;
  /** Short description of the symbol (its declaration, trimmed). */
  text: string;
  /** True when the symbol is a function/method (the UI appends a "()" hint). */
  callable: boolean;
}

export interface DefinitionTarget {
  /** Repo-relative path (forward slashes) of the file holding the definition. */
  file: string;
  /** 1-based line and character (VS Code Selection convention). */
  line: number;
  character: number;
}

export interface LookupResult {
  hover: HoverInfo | null;
  definition: DefinitionTarget | null;
}

const IDLE_TTL_MS = 60_000;
const MAX_FILES = 2000; // import-graph safety valve (node_modules can be deep)
const MAX_DECL_CHARS = 240;

interface ServiceEntry {
  svc: ts.LanguageService;
  rootFile: string; // absolute path the service was built around
  files: string[]; // the import graph the service was built with
  idle: NodeJS.Timeout | undefined;
}

const services = new Map<string, ServiceEntry>();
/** The NEWEST request per repo root. A newer request supersedes the older
 *  one (a fast mouse must not queue up language-service work); the older
 *  one resolves to null when it notices it is no longer the newest. */
let seq = 0;
const pending = new Map<string, { id: number; resolve: (v: LookupResult | null) => void }>();

/** Is this a file the language service can understand? */
export function isSupported(filePath: string): boolean {
  const e = path.extname(filePath).toLowerCase();
  return (
    e === '.ts' || e === '.tsx' || e === '.js' || e === '.jsx' ||
    e === '.mts' || e === '.cts' || e === '.mjs' || e === '.cjs' ||
    e === '.cs'
  );
}

// ---------------------------------------------------------------------------
// C# support: a small shipped helper (`cshover`, in the extension's
// `cshover/` folder) hosts Roslyn's MSBuildWorkspace — the same route the
// C# tooling uses — and answers hover/definition over JSON on stdin/stdout.
// One long-lived process; it caches a workspace per project internally.
// Requires the `dotnet` CLI on PATH (framework-dependent publish).
// ---------------------------------------------------------------------------

interface CSharpProc {
  proc: child_process.ChildProcess;
  ready: Promise<void>;
  busy: boolean;
  dead: boolean;
  queue: { id: number; resolve: (v: LookupResult | null) => void }[];
  outBuf: string;
}

let csharp: CSharpProc | undefined;
let csharpSeq = 0;
/** Repo root for each in-flight cshover request (to make definition
 *  paths repo-relative). */
const csharpRoots = new Map<number, string>();

/** Location of the shipped helper (the extension root is `..` of `out/`). */
function helperDll(): string {
  return path.join(__dirname, '..', 'cshover', 'cshover.dll');
}

function spawnCSharp(): CSharpProc {
  const entry = helperDll();
  const proc = child_process.spawn('dotnet', [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state: CSharpProc = {
    proc,
    ready: new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        if (!state.dead) {
          state.dead = true;
          proc.kill();
        }
        reject(new Error('cshover start timeout'));
      }, 90_000);
      // The helper is ready as soon as it has a stdin stream; the first
      // request's cold start (loading the project) happens in-process.
      setImmediate(() => {
        clearTimeout(t);
        resolve();
      });
    }),
    busy: false,
    dead: false,
    queue: [],
    outBuf: '',
  };
  proc.stdout!.on('data', (d: Buffer) => {
    state.outBuf += d.toString('utf8');
    let idx = state.outBuf.indexOf('\n');
    while (idx >= 0) {
      const line = state.outBuf.slice(0, idx).trim();
      state.outBuf = state.outBuf.slice(idx + 1);
      idx = state.outBuf.indexOf('\n');
      if (line.length === 0) continue;
      const next = state.queue.shift();
      if (!next) continue; // unsolicited line — ignore
      const root = csharpRoots.get(next.id) ?? process.cwd();
      csharpRoots.delete(next.id);
      try {
        next.resolve(parseCSharpReply(line, root));
      } catch {
        next.resolve(null);
      }
    }
  });
  proc.stderr!.on('data', (d: Buffer) => {
    dbg('cshover stderr: ' + d.toString('utf8').split('\n').filter(Boolean).slice(0, 3).join(' | '));
  });
  proc.on('error', (err) => {
    dbg('cshover spawn error: ' + err.message + ' (is the dotnet CLI on PATH?)');
    state.dead = true;
    for (const q of state.queue) q.resolve(null);
    state.queue = [];
  });
  proc.on('exit', () => {
    state.dead = true;
    for (const q of state.queue) q.resolve(null);
    state.queue = [];
    if (csharp === state) csharp = undefined;
  });
  return state;
}

/** Map one helper reply line to a LookupResult (paths made repo-relative). */
function parseCSharpReply(line: string, repoRoot: string): LookupResult | null {
  const obj = JSON.parse(line) as {
    hover?: { kind: string; text?: string | null; callable?: boolean } | null;
    definition?: { file: string; line: number; character: number } | null;
    error?: string | null;
  };
  if (obj.error) dbg('cshover error: ' + obj.error);
  let definition: DefinitionTarget | null = null;
  if (obj.definition && obj.definition.file) {
    // Absolute (OS-style) path → repo-relative (forward slashes). The file
    // may live in a referenced project outside this repo — keep it only
    // when it is inside (or we accept absolute → relative from cwd).
    const rel = path.relative(repoRoot, obj.definition.file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      definition = {
        file: rel.split(path.sep).join('/'),
        line: obj.definition.line,
        character: obj.definition.character,
      };
    }
  }
  if (!obj.hover && !definition) return null;
  return {
    hover: obj.hover
      ? { kind: obj.hover.kind, text: obj.hover.text ?? '', callable: !!obj.hover.callable }
      : null,
    definition,
  };
}

/** Ask the (lazily spawned) cshover helper for hover/definition. */
function csharpLookup(repoRoot: string, abs: string, line: number, character: number): Promise<LookupResult | null> {
  if (!csharp || csharp.dead) csharp = spawnCSharp();
  const state = csharp;
  const id = ++csharpSeq;
  csharpRoots.set(id, repoRoot);
  return new Promise<LookupResult | null>((resolve) => {
    // Every resolution path must forget the root for this id.
    const finish = (v: LookupResult | null) => {
      csharpRoots.delete(id);
      resolve(v);
    };
    state.queue.push({ id, resolve: finish });
    state.ready
      .catch(() => {
        // Spawn failed (e.g. no dotnet CLI): drain this request as null.
        const i = state.queue.findIndex((q) => q.id === id);
        if (i >= 0) {
          state.queue.splice(i, 1);
          finish(null);
        }
      })
      .then(() => {
        try {
          const req = JSON.stringify({
            file: abs,
            line,
            col: character,
          });
          state.proc.stdin!.write(req + '\n');
        } catch (err) {
          dbg('cshover write failed: ' + String(err));
          const i = state.queue.findIndex((q) => q.id === id);
          if (i >= 0) state.queue.splice(i, 1);
          finish(null);
        }
      });
    // Cold starts load the whole project (MSBuild restore can take a
    // while); bound the wait so the UI never hangs. The helper answers
    // strictly in order, so a timed-out request would desync the stream —
    // recycle the process instead.
    setTimeout(() => {
      const i = state.queue.findIndex((q) => q.id === id);
      if (i >= 0) {
        state.queue.splice(i, 1);
        dbg('cshover: request timed out for ' + path.relative(repoRoot, abs) + ' (recycling helper)');
        finish(null);
        state.dead = true;
        try {
          state.proc.kill();
        } catch {
          // already gone
        }
      }
    }, 120_000);
  });
}

/** Compiler options close to `tsc`'s inferred defaults — good enough for
 *  hover/definition without a tsconfig round-trip. */
function compilerOptionsFor(root: string): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    esModuleInterop: true,
    allowJs: true,
    skipLibCheck: true,
    noEmit: true,
    jsx: ts.JsxEmit.ReactJSX,
    types: [], // don't drag in @types/* automatically
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
    baseUrl: root,
  };
}

/**
 * Enumerate the script files for a LanguageServiceHost: the file under
 * review plus everything it (transitively) imports, resolved with the same
 * node module resolution `tsc` uses.
 */
function collectFiles(rootFile: string, opts: ts.CompilerOptions): string[] {
  const files = new Set<string>([rootFile]);
  const queue: string[] = [rootFile];
  while (queue.length > 0 && files.size < MAX_FILES) {
    const current = queue.shift()!;
    let src: ts.SourceFile;
    try {
      src = ts.createSourceFile(current, fs.readFileSync(current, 'utf8'), ts.ScriptTarget.ES2020, false);
    } catch {
      continue; // unreadable — skip its imports
    }
    const importSpecifiers: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const name = n.expression.text;
        if ((name === 'require' || name === 'import') && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0])) {
          importSpecifiers.push(n.arguments[0].text);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    for (const stmt of src.statements) {
      if (
        (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        importSpecifiers.push(stmt.moduleSpecifier.text);
      } else if (ts.isImportEqualsDeclaration(stmt)) {
        // `import x = require('mod')` — the reference is a string literal
        // (the d.ts union omits it, so widen before narrowing).
        const mr = stmt.moduleReference as unknown as ts.Node;
        if (ts.isStringLiteral(mr)) importSpecifiers.push(mr.text);
      }
    }
    for (const spec of importSpecifiers) {
      const resolved = ts.resolveModuleName(spec, current, opts, ts.sys);
      const file = resolved?.resolvedModule?.resolvedFileName;
      if (file && !files.has(file)) {
        files.add(file);
        queue.push(file);
      }
    }
  }
  return [...files];
}

function makeHost(root: string, scriptFileNames: string[], opts: ts.CompilerOptions): ts.LanguageServiceHost {
  return {
    getScriptFileNames: () => scriptFileNames,
    getScriptVersion: (f) => {
      try {
        return String(fs.statSync(f).mtimeMs);
      } catch {
        return '0';
      }
    },
    getScriptSnapshot: (f) => {
      try {
        return ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8'));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => opts,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
}

function disposeEntry(e: ServiceEntry): void {
  e.svc.dispose();
}

function dropWarm(root: string): void {
  const t = warmTimers.get(root);
  if (t) clearTimeout(t);
  warmTimers.delete(root);
}

function scheduleIdle(root: string): void {
  const e = services.get(root);
  if (!e) return;
  if (e.idle) clearTimeout(e.idle);
  e.idle = setTimeout(() => {
    if (services.get(root) === e) {
      disposeEntry(e);
      dropWarm(root);
      services.delete(root);
    }
  }, IDLE_TTL_MS);
}

function serviceFor(root: string, rootFile: string): ServiceEntry | undefined {
  const existing = services.get(root);
  if (existing) {
    if (existing.rootFile === rootFile) {
      if (existing.idle) {
        clearTimeout(existing.idle);
        existing.idle = undefined;
      }
      return existing;
    }
    disposeEntry(existing);
    dropWarm(root);
    services.delete(root);
  }
  const opts = compilerOptionsFor(root);
  let files: string[];
  try {
    files = collectFiles(rootFile, opts);
  } catch (err) {
    dbg('serviceFor: collectFiles THREW ' + (err instanceof Error ? err.stack ?? String(err) : String(err)));
    return undefined;
  }
  dbg(`serviceFor: built around ${path.relative(root, rootFile)} (${files.length} files)`);
  const host = makeHost(root, files, opts);
  const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
  const entry: ServiceEntry = { svc, rootFile, files, idle: undefined };
  services.set(root, entry);
  warmUp(root, entry);
  return entry;
}

/** The first hover builds a whole import graph synchronously (seconds on
 *  large projects) and the user is watching it happen. Warm the OTHER
 *  files of the graph — the most likely next hover targets — in the
 *  background, one per timer tick, so later hovers hit a warm service. */
const warmTimers = new Map<string, NodeJS.Timeout>();
function warmUp(root: string, entry: ServiceEntry): void {
  const prev = warmTimers.get(root);
  if (prev) clearTimeout(prev);
  const opts = compilerOptionsFor(root);
  const queue = entry.files.filter((f) => f !== entry.rootFile).slice(0, 40);
  const tick = (): void => {
    const next = queue.shift();
    if (!next || services.get(root) !== entry) return; // superseded or torn down
    try {
      const files = collectFiles(next, opts);
      const host = makeHost(root, files, opts);
      const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
      entry.svc.dispose();
      entry.svc = svc;
      entry.rootFile = next;
      entry.files = files;
    } catch {
      /* keep the old service */
    }
    if (queue.length > 0) warmTimers.set(root, setTimeout(tick, 250));
  };
  if (queue.length > 0) warmTimers.set(root, setTimeout(tick, 800));
}

/** Clamp the requested 1-based `line` / 0-based `character` into the file
 *  and return the absolute source offset. (The public TS 5.x API has no
 *  `getLineInfo`, so line bounds come from `lineAtPos` /
 *  `getLineAndCharacterOfPosition`.) */
function positionFor(sf: ts.SourceFile, line: number, character: number): number {
  const total = sf.text.length;
  let lo = 0;
  let hi = total;
  // Find the start offset of `line` (1-based) by binary search on lineAtPos.
  let lineStart = 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sf.getLineAndCharacterOfPosition(mid).line + 1 < line) lo = mid + 1;
    else hi = mid;
  }
  lineStart = lo;
  const lineLen = (() => {
    if (lineStart >= total) return 0;
    const nl = sf.text.indexOf('\n', lineStart);
    return nl === -1 ? total - lineStart : nl - lineStart;
  })();
  const col = Math.min(Math.max(0, character), lineLen);
  return lineStart + col;
}

const CALLABLE_KINDS = new Set([
  ts.ScriptElementKind.functionElement,
  ts.ScriptElementKind.localFunctionElement,
  ts.ScriptElementKind.memberFunctionElement,
  ts.ScriptElementKind.memberGetAccessorElement,
  ts.ScriptElementKind.memberSetAccessorElement,
  ts.ScriptElementKind.constructorImplementationElement,
]);

/** The innermost node at `pos` (for the declaration text of the hover). */
function nodeAt(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  const find = (n: ts.Node): ts.Node | undefined => {
    if (pos < n.getStart(sf) || pos >= n.getEnd()) return undefined;
    let found: ts.Node | undefined;
    ts.forEachChild(n, (c) => {
      if (found) return;
      found = find(c);
    });
    return found ?? n;
  };
  return find(sf);
}

/** A declaration's source text, flattened and capped (the hover's second
 *  line — like VS Code, which shows the symbol's declaration). */
function declTextOf(checker: ts.TypeChecker, sf: ts.SourceFile, node: ts.Node): string {
  // Show a signature for function-like nodes, the full declaration for
  // short ones, and a `name: type` line otherwise.
  if (ts.isFunctionLike(node) && node.name) {
    const params = node.parameters
      .map((p) => {
        const pn = p.name ? p.name.getText(sf) : '?';
        const pt = p.type ? p.type.getText(sf) : checker.typeToString(checker.getTypeAtLocation(p));
        return pn + (pt ? `: ${pt}` : '');
      })
      .join(', ');
    const ret = node.type ? `: ${node.type.getText(sf)}` : '';
    const head =
      node.kind === ts.SyntaxKind.MethodDeclaration
        ? 'method'
        : node.kind === ts.SyntaxKind.Constructor
          ? 'constructor'
          : 'function';
    return `${head} ${node.name.getText(sf)}(${params})${ret}`.slice(0, MAX_DECL_CHARS);
  }
  const text = node.getText(sf).replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_DECL_CHARS) return text;
  // Too long (e.g. a big object literal): collapse to `name: type`.
  const nameNode = (node as { name?: ts.Node }).name;
  if (nameNode && ts.isIdentifier(nameNode)) {
    const t = checker.typeToString(checker.getTypeAtLocation(nameNode));
    return `${nameNode.getText(sf)}: ${t}`.slice(0, MAX_DECL_CHARS);
  }
  return text.slice(0, MAX_DECL_CHARS) + '…';
}

/** Quick info for the nearest declaration NAME enclosing the position
 *  (hovering on a modifier / punctuation of one's own declaration). */
function quickInfoAtEnclosingName(svc: ts.LanguageService, sf: ts.SourceFile, pos: number): ts.QuickInfo | undefined {
  let best: ts.Identifier | undefined;
  const visit = (n: ts.Node): void => {
    if (best) return;
    if (
      ts.isIdentifier(n) &&
      pos >= n.getStart(sf) &&
      pos <= n.getEnd() &&
      (ts.isVariableDeclaration(n.parent) || ts.isFunctionDeclaration(n.parent) || ts.isClassDeclaration(n.parent) || ts.isMethodDeclaration(n.parent) || ts.isPropertyDeclaration(n.parent) || ts.isPropertySignature(n.parent) || ts.isParameter(n.parent) || ts.isEnumDeclaration(n.parent) || ts.isTypeAliasDeclaration(n.parent) || ts.isInterfaceDeclaration(n.parent))
    ) {
      best = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return best ? svc.getQuickInfoAtPosition(sf.fileName, best.getStart(sf)) : undefined;
}

/**
 * Answer a hover / definition request for `filePath` (repo-relative) at
 * 1-based `line`, 0-based `character`. Resolves to null when the file is
 * not a TS/JS file, the position carries no symbol, or the lookup fails —
 * the UI simply shows nothing.
 */
export function lookup(repoRoot: string, filePath: string, line: number, character: number): Promise<LookupResult | null> {
  if (!isSupported(filePath)) {
    dbg(`lookup: unsupported extension for ${filePath}`);
    return Promise.resolve(null);
  }
  dbg(`lookup: ${filePath}:${line}:${character} (root ${repoRoot})`);
  // Supersede any in-flight request for this root: it resolves to null as
  // soon as it notices it is no longer the newest (its own identity check,
  // below — a stale finish() can NEVER consume the newer request's promise).
  const prev = pending.get(repoRoot);
  if (prev) prev.resolve(null); // superseded — its identity check drops the rest
  const id = ++seq;
  return new Promise<LookupResult | null>((resolve) => {
    pending.set(repoRoot, { id, resolve });
    // C# goes through the cshover Roslyn helper (async); everything else
    // uses the in-process TypeScript language service (synchronous).
    const isCSharp = path.extname(filePath).toLowerCase() === '.cs';
    setImmediate(() => {
      void (async () => {
        let result: LookupResult | null = null;
        try {
          const abs = path.join(repoRoot, filePath);
          if (!fs.existsSync(abs)) {
            dbg(`lookup: file missing on disk: ${abs}`);
          } else if (isCSharp) {
            result = await csharpLookup(repoRoot, abs, line, character);
            dbg(
              'csharpLookup: result ' +
                (result
                  ? `hover=${JSON.stringify(result.hover?.kind ?? null)} def=${JSON.stringify(result.definition)}`
                  : 'null')
            );
          } else {
            const entry = serviceFor(repoRoot, abs);
            if (!entry) dbg('lookup: serviceFor returned undefined');
            if (entry) {
              result = answer(entry.svc, repoRoot, abs, line, character) ?? null;
              dbg(
                'lookup: result ' +
                  (result
                    ? `hover=${JSON.stringify(result.hover?.kind ?? null)} def=${JSON.stringify(result.definition)}`
                    : 'null (no symbol at position or no source file)')
              );
            }
          }
        } catch (err) {
          dbg('lookup: THREW ' + (err instanceof Error ? err.stack ?? String(err) : String(err)));
          result = null;
        } finally {
          if (!isCSharp) scheduleIdle(repoRoot);
        }
        // Deliver ONLY if this is still the newest request — otherwise a slow
        // answer for line A must not land as the answer to line B (the
        // webview would show a tooltip for the wrong symbol, and "Go to
        // Definition" would open the wrong file).
        if (pending.get(repoRoot)?.id === id) {
          pending.delete(repoRoot);
          dbg('lookup: delivering result to newest request');
          resolve(result);
        } else {
          dbg(`lookup: superseded (id ${id}), dropping result`);
        }
      })();
    });
  });
}

/** The actual hover/definition work for one request (synchronous). */
function answer(svc: ts.LanguageService, repoRoot: string, abs: string, line: number, character: number): LookupResult | undefined {
  const sf = svc.getProgram()!.getSourceFile(abs);
  if (!sf) return undefined;
  const checker = svc.getProgram()!.getTypeChecker();

  // Try the exact offset first, then a little around it: the mouse
  // position sits BETWEEN characters, and symbols can start one to
  // the left of where the cursor is.
  const pos = positionFor(sf, line, character);
  let quick = svc.getQuickInfoAtPosition(abs, pos) ?? svc.getQuickInfoAtPosition(abs, Math.max(0, pos - 1));
  if (!quick) quick = quickInfoAtEnclosingName(svc, sf, pos);
  if (!quick) {
    dbg(`answer: no quick info at offset ${pos} (line ${line}, col ${character}) in ${path.relative(repoRoot, abs)}`);
    return undefined;
  }

  // Second hover line: the symbol's own declaration.
  let declText = '';
  const symStart = Math.min(pos, quick.textSpan.start);
  const node = nodeAt(sf, symStart);
  if (node) {
    const sym = checker.getSymbolAtLocation(node);
    const declNode = sym?.valueDeclaration ?? sym?.declarations?.[0] ?? node;
    declText = declTextOf(checker, sf, declNode);
  }

  let definition: DefinitionTarget | null = null;
  const defs = svc.getDefinitionAtPosition(abs, pos) ?? svc.getDefinitionAtPosition(abs, Math.max(0, pos - 1));
  dbg(`answer: ${defs?.length ?? 0} definition(s) at offset ${pos}`);
  if (defs && defs.length > 0) {
    // Prefer the .ts/.tsx SOURCE over a compiled .d.ts stub when the
    // symbol is re-exported through a declaration file (the definition
    // list usually carries both) — "Go to Definition" should land in
    // the real source.
    const sourceful = defs.find((d) => /\.(tsx?|jsx?)$/.test(d.fileName) && !d.fileName.endsWith('.d.ts'));
    let first = remapToSource(sourceful ?? defs[0]);
    // Workspace packages arrive through the node_modules SYMLINK
    // (node_modules/@aftermath/x -> packages/x). When the real file lives
    // inside the repo, point there — the tab should show the source path,
    // not a node_modules copy.
    if (first.fileName.includes('node_modules')) {
      try {
        const real = fs.realpathSync(first.fileName);
        const relReal = path.relative(repoRoot, real);
        if (!relReal.startsWith('..') && !path.isAbsolute(relReal)) first = { ...first, fileName: real };
      } catch {
        /* not a symlink — keep the resolved path */
      }
    }
    const rel = path.relative(repoRoot, first.fileName).split(path.sep).join('/');
    const df = svc.getProgram()!.getSourceFile(first.fileName);
    if (df) {
      const lc = df.getLineAndCharacterOfPosition(first.textSpan.start);
      definition = { file: rel, line: lc.line + 1, character: lc.character + 1 };
    } else {
      // The remapped source file is outside the program (the program
      // only knows the compiled d.ts) — compute the position from disk.
      try {
        const text = fs.readFileSync(first.fileName, 'utf8');
        const start = Math.max(0, Math.min(first.textSpan.start, text.length));
        const before = text.slice(0, start);
        const lineNo = before.split('\n').length; // 1-based
        const charNo = start - (before.lastIndexOf('\n') + 1) + 1; // 1-based
        definition = { file: rel, line: lineNo, character: charNo };
      } catch {
        /* unreadable — skip the definition */
      }
    }
  }
  return {
    hover: {
      kind: quickDisplayText(quick),
      text: declText,
      callable: CALLABLE_KINDS.has(quick.kind) || /\(\)/.test(quick.kindModifiers ?? ''),
    },
    definition,
  };
}

/**
 * When a definition lands in a COMPILED declaration file (`.../out/x.d.ts`
 * of a workspace package — the program only sees the built output), try to
 * land in the package's SOURCE instead: `.../src/x.ts`, at the line that
 * declares the same name. Falls back to the original target when no source
 * twin exists or the name can't be found in it.
 */
function remapToSource(d: ts.DefinitionInfo): ts.DefinitionInfo {
  const flat = d.fileName.replace(/\\/g, '/');
  const m = /(^|\/)out\/(.+)\.d\.ts$/.exec(flat);
  if (!m) return d;
  // m.index points AT the separator before "out/" — keep it.
  const srcDir = flat.slice(0, m.index) + '/src';
  const base = m[2];
  const candidates = [srcDir + '/' + base + '.ts', srcDir + '/' + base + '.tsx'];
  const symName = d.name;
  for (const cand of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(cand, 'utf8');
    } catch {
      continue;
    }
    if (!symName) continue;
    // First line that declares/exports the symbol name as a word.
    const lines = text.split('\n');
    const re = new RegExp('\\b' + symName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    for (let i = 0; i < lines.length; i++) {
      if (/^(export\s+)?(function|class|const|let|var|interface|type|enum)\b/.test(lines[i]) && re.test(lines[i])) {
        // Point at the NAME (not the `export`/`function` keyword).
        const nameIdx = lines[i].lastIndexOf(symName);
        const start = offsetOfLine(lines, i) + (nameIdx > 0 ? nameIdx : lines[i].search(re));
        return { ...d, fileName: cand, textSpan: { start, length: symName.length } };
      }
    }
  }
  return d;
}

function offsetOfLine(lines: string[], i: number): number {
  let off = 0;
  for (let k = 0; k < i; k++) off += lines[k].length + 1;
  return off;
}

/** The quick info's `displayParts` flattened to one line (this IS the
 *  `const x: T` / `function f(...): R` signature VS Code shows). */
function quickDisplayText(quick: ts.QuickInfo): string {
  if (quick.displayParts && quick.displayParts.length > 0) {
    return quick.displayParts.map((p) => p.text).join('').replace(/\s+/g, ' ').trim().slice(0, MAX_DECL_CHARS);
  }
  return quick.kind;
}
