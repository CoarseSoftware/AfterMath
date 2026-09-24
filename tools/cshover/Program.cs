// cshover — a tiny long-running Roslyn host for the After Math review GUI.
//
// Protocol (one JSON object per line):
//   stdin:  {"file": "C:\\proj\\Foo.cs", "line": 42, "col": 10}
//   stdout: {"hover": {"kind": "...", "text": "...", "callable": true} | null,
//            "definition": {"file": "C:\\proj\\Bar.cs", "line": 4, "character": 5} | null}
//
// The review webview has no editor, so type info and "Go to Definition"
// come from here. The process loads the C# project (nearest .csproj/.sln)
// through MSBuildWorkspace, caches the workspace per project, and answers
// hover/definition from the real compiler. When no project is found the
// file is parsed on its own (still enough for local symbols).
//
// NOTE: written against the exact API surface of the Roslyn 4.14 packages
// shipped on this box (verified by reflection). In particular:
//   - no CodeAnalysisExtensions: use instance members
//     (Document.GetSyntaxRootAsync/GetSemanticModelAsync,
//      MSBuildWorkspace.OpenSolutionAsync/OpenProjectAsync, ...)
//   - base syntax types are named *DeclarationSyntax
//     (BaseMethodDeclarationSyntax, BasePropertyDeclarationSyntax, ...)
//   - SyntaxToken.Kind/IsKind don't exist; use token.RawKind
//   - SemanticModel has LookupSymbols/LookupNamespacesAndTypes/
//     GetEnclosingSymbol but no GetSymbolInfo
//   - ISymbol.ToDisplayString requires a SymbolDisplayFormat argument
using System.Collections.Immutable;
using Microsoft.CodeAnalysis.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Workspaces;

using JsonSerializer = System.Text.Json.JsonSerializer;

internal static class Program
{
    private static readonly JsonSerializerOptions Opts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    private static readonly SymbolDisplayFormat DisplayFormat = SymbolDisplayFormat.MinimallyQualifiedFormat;

    private static async Task Main()
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        await using var stdin = Console.OpenStandardInput();
        using var reader = new StreamReader(stdin);
        string? line;
        while ((line = await reader.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var resp = new Response { Hover = null, Definition = null };
            try
            {
                var req = JsonSerializer.Deserialize<Request>(line, Opts);
                if (req is not null && !string.IsNullOrEmpty(req.File))
                {
                    var svc = new Service(req.File);
                    svc.Answer(req.Line, req.Col, resp);
                }
            }
            catch (Exception ex)
            {
                resp.Error = ex.Message;
            }
            Console.WriteLine(JsonSerializer.Serialize(resp, Opts));
            Console.Out.Flush();
        }
    }

    private sealed class Request
    {
        public string? File { get; set; }
        public int Line { get; set; } // 1-based
        public int Col { get; set; } // 0-based
    }

    private sealed class Response
    {
        public Hover? Hover { get; set; }
        public Definition? Definition { get; set; }
        public string? Error { get; set; }
    }

    private sealed class Hover
    {
        public string Kind { get; set; } = "";
        public string? Text { get; set; }
        public bool Callable { get; set; }
    }

    private sealed class Definition
    {
        public string File { get; set; } = "";
        public int Line { get; set; } // 1-based
        public int Character { get; set; } // 1-based
    }

    private sealed class Service
    {
        // Workspace cache: keyed by project path + newest mtime of the
        // project's C# files, so edits invalidate it. Bounded to a few
        // entries (Roslyn workspaces are heavy).
        private static readonly Dictionary<string, Workspace> Cache = new(StringComparer.OrdinalIgnoreCase);
        private static readonly object CacheLock = new();

        private readonly string _file;

        public Service(string file) => _file = file;

        public void Answer(int line, int col, Response resp)
        {
            var ws = WorkspaceFor(_file);
            if (ws is null) { Console.Error.WriteLine("cshover: no workspace for " + _file); return; }

            // Locate the document for this file (case- and slash-insensitive).
            var want = Path.GetFullPath(_file).Replace('/', Path.DirectorySeparatorChar);
            var doc = ws.CurrentSolution.Projects
                .SelectMany((pp) => pp.Documents)
                .FirstOrDefault((d) => string.Equals(
                    d.FilePath.Replace('/', Path.DirectorySeparatorChar),
                    want, StringComparison.OrdinalIgnoreCase));
            if (doc is null)
            {
                var all = ws.CurrentSolution.Projects.SelectMany((pp) => pp.Documents).Select((dd) => dd.FilePath).Take(5).ToList();
                Console.Error.WriteLine("cshover: no doc for " + _file + " (have: " + string.Join("; ", all) + ")");
                return;
            }

            var root = doc.GetSyntaxRootAsync(CancellationToken.None).GetAwaiter().GetResult();
            if (root is null) { Console.Error.WriteLine("cshover: no syntax root"); return; }
            var tree = root.SyntaxTree;

            // The webview's column is 0-based (VS Code convention); Roslyn
            // positions are absolute offsets. Clamp into the file.
            // \r\n (and lone \r) count as ONE line break, like VS Code.
            if (line < 1) return;
            var text = tree.GetText(CancellationToken.None).ToString();
            int offset = 0;
            int lineNo = 0;
            while (offset < text.Length && lineNo < line - 1)
            {
                if (text[offset] == '\r')
                {
                    lineNo++;
                    offset += (offset + 1 < text.Length && text[offset + 1] == '\n') ? 2 : 1;
                }
                else
                {
                    if (text[offset] == '\n') lineNo++;
                    offset++;
                }
            }
            offset += Math.Max(0, col);
            if (offset > text.Length) offset = text.Length;

            var model = doc.GetSemanticModelAsync(CancellationToken.None).GetAwaiter().GetResult();
            if (model is null) return;

            // The identifier (or keyword) under the cursor.
            var token = root.FindToken(offset, false);
            var name = TokenName(root, offset, token);
            if (name is null) { Console.Error.WriteLine("cshover: no name at offset " + offset + " token=" + token.Text); return; }

            ISymbol? sym = null;

            // 1) Local/parameter/field declarations: the cursor on the
            //    declared name is inside the symbol's span.
            var enclosing = model.GetEnclosingSymbol(offset, CancellationToken.None);
            if (enclosing is not null
                && (enclosing.Kind == SymbolKind.Local || enclosing.Kind == SymbolKind.Parameter || enclosing.Kind == SymbolKind.Field)
                && enclosing.Locations.Any((l) => l.IsInSource && l.SourceSpan.Start <= offset && offset < l.SourceSpan.End))
            {
                sym = enclosing;
            }

            // 2) Usages: name lookup at the position.
            sym ??= Pick(model.LookupSymbols(offset, null, name, true), name);
            sym ??= Pick(model.LookupNamespacesAndTypes(offset, null, name), name);

            // 3) Declarations of methods/properties/types/...: when the
            //    name lookup misses (some declaration names don't come up),
            //    the cursor must sit on the declaration's own name token.
            sym ??= DeclaredSymbolAt(model, root, offset, token);

            if (sym is null) { Console.Error.WriteLine("cshover: no symbol for '" + name + "' at " + offset); return; }

            // --- hover -----------------------------------------------------
            resp.Hover = new Hover
            {
                Kind = Describe(sym),
                Text = DeclarationText(sym),
                Callable = sym is IMethodSymbol or IPropertySymbol,
            };

            // --- definition -----------------------------------------------
            var decls = sym.DeclaringSyntaxReferences
                .Where((r) => r.SyntaxTree is not null
                              && !r.SyntaxTree.FilePath.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase)
                              && !r.SyntaxTree.FilePath.EndsWith(".Designer.cs", StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (decls.Count == 0) decls = sym.DeclaringSyntaxReferences.Where((r) => r.SyntaxTree is not null).ToList();
            var def = decls.FirstOrDefault();
            if (def is not null)
            {
                var node = def.GetSyntax(CancellationToken.None);
                var first = node.GetFirstToken();
                var pos = def.SyntaxTree.GetLineSpan(TextSpan.FromBounds(first.SpanStart, first.SpanStart), CancellationToken.None);
                resp.Definition = new Definition
                {
                    File = def.SyntaxTree.FilePath,
                    Line = pos.StartLinePosition.Line + 1,
                    Character = pos.StartLinePosition.Character + 1,
                };
            }
        }

        // Identifier (or keyword) text under the cursor, trying the token
        // before the offset when the cursor sits right after it.
        private static string? TokenName(SyntaxNode root, int offset, SyntaxToken token)
        {
            if (token.RawKind == (int)SyntaxKind.IdentifierToken && token.ValueText.Length > 0)
                return token.ValueText;
            var before = root.FindToken(offset - 1, false);
            if (before.RawKind == (int)SyntaxKind.IdentifierToken && before.ValueText.Length > 0)
                return before.ValueText;
            if (token.Text.Length > 0 && char.IsLetter(token.Text[0]))
                return token.Text;
            if (before.Text.Length > 0 && char.IsLetter(before.Text[0]))
                return before.Text;
            return null;
        }

        // From a lookup result, prefer the symbol whose name matches (the
        // lookup can return namespace-or-type candidates with other shapes).
        private static ISymbol? Pick(ImmutableArray<ISymbol> candidates, string name)
        {
            return candidates.FirstOrDefault((s) => s is not null && string.Equals(s.Name, name, StringComparison.Ordinal))
                   ?? candidates.FirstOrDefault((s) => s is not null);
        }

        // When the cursor is on a declaration's own name (e.g. the method
        // name in its signature), resolve the enclosing declaration node
        // and map it to a symbol.
        private static ISymbol? DeclaredSymbolAt(SemanticModel model, SyntaxNode root, int offset, SyntaxToken token)
        {
            // Only meaningful when the cursor is on an identifier that is
            // the declared name (not an invocation, which the lookups above
            // already handle).
            if (token.RawKind != (int)SyntaxKind.IdentifierToken) return null;
            if (root.FindToken(token.SpanStart, false) != token) return null;

            var node = token.Parent;
            while (node is not null && !(node is MethodDeclarationSyntax
                                         or ConstructorDeclarationSyntax
                                         or BasePropertyDeclarationSyntax
                                         or VariableDeclarationSyntax
                                         or BaseFieldDeclarationSyntax
                                         or EventDeclarationSyntax
                                         or TypeDeclarationSyntax
                                         or DelegateDeclarationSyntax
                                         or EnumMemberDeclarationSyntax
                                         or BaseNamespaceDeclarationSyntax
                                         or UsingDirectiveSyntax
                                         or LocalFunctionStatementSyntax
                                         or ParameterSyntax))
            {
                node = node.Parent;
            }
            if (node is null) return null;

            // The cursor must be on this declaration's own name token � not
            // merely somewhere inside it (e.g. an invocation in its body).
            // The name is the first identifier token at or before the node's
            // first identifier position... simply: the token must be an
            // ancestor-or-self name of the declaration, i.e. walking up from
            // the token must hit the declaration before any expression.
            var walker = token.Parent;
            while (walker is not null && walker != node)
            {
                if (walker is InvocationExpressionSyntax
                    or MemberAccessExpressionSyntax
                    or ConditionalAccessExpressionSyntax
                    or ObjectCreationExpressionSyntax
                    or ArgumentListSyntax
                    or InitializerExpressionSyntax)
                {
                    return null; // cursor is inside an expression, not a name
                }
                walker = walker.Parent;
            }
            if (walker is null) return null;

            var sym = model.GetEnclosingSymbol(offset, CancellationToken.None);
            if (sym is not null && sym is not INamespaceSymbol && sym is not IAssemblySymbol)
                return sym;
            return null;
        }

        private static string Describe(ISymbol sym) => sym switch
        {
            IMethodSymbol m => $"method {m.ContainingType?.Name}.{m.Name}({m.Parameters.Select(Describe).Join(", ")}): {m.ReturnType.ToDisplayString(DisplayFormat)}",
            IPropertySymbol p => $"property {p.ContainingType?.Name}.{p.Name}: {p.Type.ToDisplayString(DisplayFormat)}",
            IFieldSymbol f => $"field {f.ContainingType?.Name}.{f.Name}: {f.Type.ToDisplayString(DisplayFormat)}",
            IParameterSymbol p => $"parameter {p.Name}: {p.Type.ToDisplayString(DisplayFormat)}",
            ILocalSymbol l => $"local {l.Name}: {l.Type.ToDisplayString(DisplayFormat)}",
            INamedTypeSymbol t => (t.IsGenericType ? "generic " : "") + t.ToDisplayString(DisplayFormat),
            IEventSymbol e => $"event {e.ContainingType?.Name}.{e.Name}: {e.Type.ToDisplayString(DisplayFormat)}",
            _ => sym.ToDisplayString(DisplayFormat),
        };

        private static string Describe(IParameterSymbol p) => $"{p.Name}: {p.Type.ToDisplayString(DisplayFormat)}";

        private static string? DeclarationText(ISymbol sym)
        {
            var def = sym.DeclaringSyntaxReferences.FirstOrDefault((r) => r.SyntaxTree is not null);
            if (def is null) return null;
            try
            {
                var syntax = def.GetSyntax(CancellationToken.None);
                // Walk up to the outermost declaration that renders nicely
                // (so a parameter shows its whole method, a field its line).
                while (syntax.Parent is not null
                       && !(syntax.Parent is BaseMethodDeclarationSyntax or BasePropertyDeclarationSyntax or VariableDeclarationSyntax or BaseFieldDeclarationSyntax or BaseNamespaceDeclarationSyntax or TypeDeclarationSyntax or InterfaceDeclarationSyntax or StructDeclarationSyntax or EnumDeclarationSyntax or RecordDeclarationSyntax or DelegateDeclarationSyntax or EventDeclarationSyntax or ClassDeclarationSyntax))
                {
                    syntax = syntax.Parent;
                }
                var text = syntax.ToString().ReplaceLineEndings(" ");
                return text.Length <= 240 ? text : text[..240] + "…";
            }
            catch
            {
                return null;
            }
        }

        private static Workspace? WorkspaceFor(string file)
        {
            var key = ProjectKeyFor(file);
            lock (CacheLock)
            {
                if (Cache.TryGetValue(key, out var hit)) return hit;
            }

            Workspace? ws = null;
            var projectPath = FindProject(file);
            if (projectPath is not null)
            {
                try
                {
                    var newWs = MSBuildWorkspace.Create();
                    var opened = projectPath.EndsWith(".sln", StringComparison.OrdinalIgnoreCase)
                        ? newWs.OpenSolutionAsync(projectPath, null, CancellationToken.None).GetAwaiter().GetResult() is not null
                        : newWs.OpenProjectAsync(projectPath, null, CancellationToken.None).GetAwaiter().GetResult() is not null;
                    ws = opened ? newWs : null;
                }
                catch
                {
                    ws = null; // fall through to the file-only workspace below
                }
            }
            ws ??= FallbackWorkspace(file);

            lock (CacheLock)
            {
                if (Cache.Count > 4) Cache.Clear(); // bound memory: keep only recent projects
                Cache[key] = ws;
            }
            return ws;
        }

        private static string ProjectKeyFor(string file)
        {
            var p = FindProject(file);
            try
            {
                var dir = Path.GetDirectoryName(file);
                var mtime = dir is null ? 0 : Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)
                    .Where((f) => f.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".sln", StringComparison.OrdinalIgnoreCase))
                    .Select((f) => new FileInfo(f).LastWriteTimeUtc.Ticks)
                    .DefaultIfEmpty(0).Max();
                return (p ?? file) + "@" + mtime;
            }
            catch
            {
                return p ?? file;
            }
        }

        private static string? FindProject(string file)
        {
            var dir = new DirectoryInfo(Path.GetDirectoryName(file) ?? "");
            while (dir is not null)
            {
                try
                {
                    var slns = dir.EnumerateFiles("*.sln");
                    var sln = slns.FirstOrDefault();
                    if (sln is not null) return sln.FullName;
                    var projs = dir.EnumerateFiles("*.csproj").ToList();
                    if (projs.Count > 0) return projs[0].FullName;
                }
                catch
                {
                    // keep walking up
                }
                dir = dir.Parent;
            }
            return null;
        }

        private static Workspace FallbackWorkspace(string file)
        {
            // No project found: parse the file alone so local symbols still
            // resolve. Built fresh each call (it is cheap and short-lived).
            var text = System.IO.File.ReadAllText(file);
            var ws = new AdhocWorkspace();
            var project = ws.AddProject("adhoc", "C#");
            project.AddDocument(Path.GetFileName(file), text, Array.Empty<string>(), file);
            return ws;
        }
    }
}

internal static class LinqExt
{
    public static string Join(this IEnumerable<string> items, string sep) => string.Join(sep, items);
}

internal static class TokenExt
{
    // The first identifier (or keyword) token of a node.
    public static bool IsKind_Safe(this SyntaxToken t) => t.RawKind == (int)SyntaxKind.IdentifierToken;
}
