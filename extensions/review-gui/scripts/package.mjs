// Builds after-math-<version>.vsix directly, bypassing @vscode/vsce.
//
// Why: vsce walks the filesystem for the file list when the project is not a
// git repo, and npm's workspace symlink (node_modules/after-math -> monorepo
// root) drags the entire parent tree into the package, which vsce then rejects
// ("invalid relative path: extension/../../.gitignore").
//
// A .vsix is just a zip: [Content_Types].xml + extension.vsixmanifest at the
// root, everything else under extension/. We include only what the runtime
// needs: package.json, out/**, media/**.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, `after-math-${pkg.version}.vsix`);
fs.rmSync(outDir, { force: true });

// ---- collect files ---------------------------------------------------------
// `rel` is always slash-separated (see walk), even on Windows
const include = (rel) =>
  rel === 'package.json' ||
  rel.startsWith('out/') ||
  // The cshover Roslyn helper (C# hover + go-to-definition). Shipped as the
  // trimmed `dotnet publish` output; see tools/cshover.
  rel.startsWith('cshover/') ||
  rel.startsWith('media/') ||
  rel.startsWith('node_modules/@aftermath/') ||
  // The TypeScript compiler (hover type info + go-to-definition in the
  // review panel). Only the bits the runtime actually loads — the ~9 MB
  // lib/typescript.js, its types, the package.json and LICENSE.
  (rel.startsWith('node_modules/typescript/') &&
    (rel === 'node_modules/typescript/package.json' ||
      rel === 'node_modules/typescript/LICENSE' ||
      rel === 'node_modules/typescript/lib/typescript.js' ||
      rel === 'node_modules/typescript/lib/typescript.d.ts' ||
      rel === 'node_modules/typescript/lib/lib.es2020.d.ts' ||
      rel === 'node_modules/typescript/lib/lib.dom.d.ts'));

const files = []; // { rel, src } — src is the real on-disk path of the file
const walk = (dir, rel, srcBase = root) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    // npm workspace deps are symlinks; withFileTypes doesn't follow them
    const isDir = e.isDirectory() || (e.isSymbolicLink() && fs.statSync(full).isDirectory());
    if (isDir) walk(full, r, srcBase);
    else if (include(r)) files.push({ rel: r, src: full });
  }
};
walk(root, '');
// Workspace dependencies are symlinked (npm hoists them to the monorepo root
// node_modules), which the main walk deliberately skips — collect them
// explicitly. At runtime the extension host needs @aftermath/protocol next to
// the extension code.
const depCandidates = [
  path.join(root, 'node_modules', '@aftermath'),
  path.join(root, '..', '..', 'node_modules', '@aftermath'), // monorepo root
  path.join(root, 'node_modules', 'typescript'),
  path.join(root, '..', '..', 'node_modules', 'typescript'), // monorepo root
];
for (const depRoot of depCandidates) {
  let real;
  try {
    real = fs.realpathSync(depRoot);
  } catch {
    continue;
  }
  walk(real, real.endsWith('typescript') ? 'node_modules/typescript' : 'node_modules/@aftermath', real);
}

// ---- vsixmanifest ----------------------------------------------------------
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const contribs = pkg.contributes ?? {};
const commands = (contribs.commands ?? [])
  .map((c) => `<Command><Id>${esc(c.command)}</Id><Title>${esc(c.title)}</Title></Command>`)
  .join('');
const viewsContainers = Object.entries(contribs.viewsContainers ?? {})
  .flatMap(([containerId, views]) =>
    views
      .map(
        (v) =>
          `<ViewsContainer><Id>${esc(v.id)}</Id><Title>${esc(v.title)}</Title><Location>${esc(
            containerId
          )}</Location></ViewsContainer>`
      )
  )
  .join('');
const views = Object.entries(contribs.views ?? {})
  .flatMap(([containerId, viewsIn]) =>
    viewsIn
      .map(
        (v) =>
          `<View><Id>${esc(v.id)}</Id><Name>${esc(v.name)}</Name><Type>tree</Type><Visibility>visible</Visibility><ViewsContainerId>${esc(
            containerId
          )}</ViewsContainerId><When></When><Directory></Directory></View>`
      )
      .join('')
  )
  .join('');
const configProps = Object.entries(contribs.configuration?.properties ?? {})
  .map(([id, p]) => `<Property><Id>${esc(id)}</Id><Name>${esc(id)}</Name></Property>`)
  .join('');

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/VisualStudio/package/2011/08/VisualStudio">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.displayName)}" Version="${esc(pkg.version)}" Publisher="${esc(
      pkg.publisher
    )}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description Language="en-US">${esc(pkg.description)}</Description>
    <MoreInfo>${esc(pkg.repository?.url ?? 'https://coarse-software.com/after-math')}</MoreInfo>
    <GalleryFlags>1</GalleryFlags>
    <Category>Other</Category>
    <Tags>${esc((pkg.tags ?? []).join(' '))}</Tags>
    <Properties>
      <Property Id="GlobalDependencies" Value=""/>
      <Property Id="ShutdownKind" Value="DoNotShutdown"/>
      <Property Id="LaunchService" Value="false"/>
      <Property Id="NonExecutable" Value=""/>
      <Property Id="EnabledByDefault" Value="1"/>
      <Property Id="AutoUpdate" Value="0"/>
      <Property Id="DisplayVersion" Value="${esc(pkg.version)}"/>
      <Property Id="Description" Value="${esc(pkg.description)}"/>
    </Properties>
    <License>MIT</License>
    <Icon>extension/media/icon.png</Icon>
    <ProjectUrlOnGalary>${esc(pkg.repository?.url ?? 'https://coarse-software.com/after-math')}</ProjectUrlOnGalary>
    <ApplicableProduct>
      <Id>Microsoft.VisualStudio.Community</Id>
      <Version>[${esc(pkg.engines.vscode.replace(/^\^/, ''))},)</Version>
    </ApplicableProduct>
    <MediaRequirements>3</MediaRequirements>
    <Installation>
      <InstallActionType>InstallAction</InstallActionType>
    </Installation>
    <MoreInformation>
      <MoreInfoItem>After Math: local code review for AI coding sessions.</MoreInfoItem>
    </MoreInformation>
  </Metadata>
  <Installation>
    <Install>
      <InstallSet>
        <InstallSetTarget InstallationVersion="${esc(pkg.version)}"/>
      </InstallSet>
    </Install>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Author="${esc(pkg.publisher)}" Id="Microsoft.VisualStudio.Services" Type="Microsoft.VisualStudio.Services" Version="16.0" Content="package.json" />
    <Asset Author="${esc(pkg.publisher)}" Id="Vscode.extension" Type="Vscode.extension" Version="${esc(
      pkg.version
    )}" Content="extension/" />
    ${viewsContainers ? `<Asset Author="${esc(pkg.publisher)}" Id="Vscode.extension.viewsContainers" Type="Vscode.extension" Content="${esc(
      viewsContainers
    )}" />` : ''}
    ${views ? `<Asset Author="${esc(pkg.publisher)}" Id="Vscode.extension.views" Type="Vscode.extension" Content="${esc(
      views
    )}" />` : ''}
    ${commands ? `<Asset Author="${esc(pkg.publisher)}" Id="Vscode.extension.commands" Type="Vscode.extension" Content="${esc(
      commands
    )}" />` : ''}
    ${configProps ? `<Asset Author="${esc(pkg.publisher)}" Id="Vscode.configuration" Type="Vscode.configuration" Content="${esc(
      configProps
    )}" />` : ''}
  </Assets>
</PackageManifest>
`;

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="xml" ContentType="application/xml" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="map" ContentType="application/json" />
  <Default Extension="d.ts" ContentType="text/plain" />
</Types>
`;

// ---- assemble + zip --------------------------------------------------------
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-'));
fs.writeFileSync(path.join(stage, '[Content_Types].xml'), contentTypes);
fs.writeFileSync(path.join(stage, 'extension.vsixmanifest'), manifest);
for (const { rel, src } of files) {
  const dest = path.join(stage, 'extension', rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Pure-Node ZIP writer (method 0 = stored). Every other route on this box is
// broken: Compress-Archive's wildcard parsing mangles "[Content_Types].xml"
// (brackets = character class), .NET ZipFile's data-descriptor layout trips
// up yauzl, and Windows' bundled tar has no zip write support. The vsix is
// small, so uncompressed entries are fine.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const zipBufs = [];
const central = [];
let offset = 0;
let entryCount = 0;
const dosDateTime = (() => {
  const d = new Date();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
})();
const addEntry = (name, buf) => {
  const crc = crc32(buf);
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt16LE(dosDateTime.time, 10);
  local.writeUInt16LE(dosDateTime.date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(buf.length, 18); // compressed size
  local.writeUInt32LE(buf.length, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  zipBufs.push(local, nameBuf, buf);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4); // version made by
  cen.writeUInt16LE(20, 6); // version needed
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(0, 10);
  cen.writeUInt16LE(dosDateTime.time, 12);
  cen.writeUInt16LE(dosDateTime.date, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(buf.length, 20);
  cen.writeUInt32LE(buf.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt32LE(offset, 42);
  central.push(cen, nameBuf);
  offset += 30 + nameBuf.length + buf.length;
  entryCount++;
};

// stage contains only what we explicitly staged — no filtering here
const pushDir = (dir, rel) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) pushDir(path.join(dir, e.name), r);
    else addEntry(r, fs.readFileSync(path.join(dir, e.name)));
  }
};
pushDir(stage, '');

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(entryCount, 8);
eocd.writeUInt16LE(entryCount, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
zipBufs.push(centralBuf, eocd);
fs.writeFileSync(path.join(stage, '..', 'am.zip'), Buffer.concat(zipBufs));
const zip = path.join(stage, '..', 'am.zip');
// copy, not rename: temp dir and repo may be on different volumes
fs.copyFileSync(zip, outDir);
fs.rmSync(zip, { force: true });
fs.rmSync(stage, { recursive: true, force: true });

// The installer ships in the repo (dist/) and in GitHub Releases, so the
// extension can be installed from the command line without the store.
const distDir = path.resolve(root, '..', '..', 'dist');
fs.mkdirSync(distDir, { recursive: true });
const distFile = path.join(distDir, path.basename(outDir));
fs.copyFileSync(outDir, distFile);

console.log(`Packaged: ${outDir}`);
console.log(`Installer: ${distFile}`);
console.log(`Files included (${files.length}):`);
for (const { rel } of files) console.log(`  ${rel}`);
