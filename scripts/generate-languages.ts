import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

interface SourceDefinitions {
  aliases: Map<string, string>;
  icons: Map<string, string>;
}

interface Language {
  id: string;
  label: string;
  aliases: string[];
}

interface Icon {
  file: string;
  identifier: string;
  svg: string;
}

export function extractDefinitions(source: string): SourceDefinitions {
  const file = ts.createSourceFile('Const.ts', source, ts.ScriptTarget.Latest, true);
  const tables = new Map<string, Map<string, string>>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !['Languages', 'manualLang', 'Icons'].includes(declaration.name.text)) continue;
      if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) {
        throw new Error(`Expected a static object for ${declaration.name.text}.`);
      }
      const entries = new Map<string, string>();
      for (const property of declaration.initializer.properties) {
        if (!ts.isPropertyAssignment(property) ||
            !(ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) ||
            !(ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer))) {
          throw new Error(`Expected static string entries in ${declaration.name.text}.`);
        }
        entries.set(property.name.text, property.initializer.text);
      }
      tables.set(declaration.name.text, entries);
    }
  }
  const primary = tables.get('Languages');
  const manual = tables.get('manualLang');
  const icons = tables.get('Icons');
  if (!primary || !manual || !icons) throw new Error('Missing Languages, manualLang, or Icons table.');
  // CC resolves Languages before manualLang when both contain the same alias.
  return { aliases: new Map([...manual, ...primary]), icons };
}

function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\r', '\\r').replaceAll('\n', '\\n')}'`;
}

function svgDocument(content: string): string {
  const cleaned = content.trim().replace(/^(?:<\?xml[^>]*>\s*|<!DOCTYPE[^>]*>\s*|<!--[\s\S]*?-->\s*)*/i, '');
  const body = /^<svg[\s>]/i.test(cleaned)
    ? cleaned.replace(/^<svg[^>]*>/i, (root) => root.replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi, ''))
    : content;
  if (/<script\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*['"](?:https?:|\/\/|javascript:)|url\(\s*['"]?(?:https?:|\/\/)/i.test(body)) {
    throw new Error('SVG icons must not contain scripts, event handlers, or external resources.');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32">${body}</svg>\n`;
}

function fileStem(id: string): string {
  const stem = id.toLowerCase().replaceAll('+', '-plus').replaceAll('#', '-sharp')
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  if (!stem) throw new Error(`Cannot generate an icon filename for "${id}".`);
  return stem;
}

export function generateLanguageFiles(source: string): {
  files: Map<string, string>;
  aliasCount: number;
  languageCount: number;
  iconCount: number;
} {
  const definitions = extractDefinitions(source);
  const grouped = new Map<string, string[]>();
  for (const [alias, label] of definitions.aliases) {
    if (alias !== alias.toLowerCase()) throw new Error(`CC alias "${alias}" is not lowercase.`);
    const aliases = grouped.get(label) ?? [];
    aliases.push(alias);
    grouped.set(label, aliases);
  }
  const languages: Language[] = [];
  for (const [label, aliases] of grouped) {
    const lower = label.toLowerCase();
    const id = aliases.find((alias) => alias === lower) ??
      aliases.find((alias) => alias === lower.replace(/[^a-z0-9]/g, '')) ?? aliases[0]!;
    languages.push({ id, label, aliases: aliases.filter((alias) => alias !== id).sort() });
  }
  languages.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const icons = new Map<string, Icon>();
  const files = new Map<string, string>();
  const identifiers = new Set<string>();
  for (const [label, content] of definitions.icons) {
    const stem = fileStem(label);
    const file = `src/icons/${stem}.svg`;
    const camel = stem.replace(/[._-]+([a-z0-9])/g, (_, character: string) => character.toUpperCase());
    const identifier = `${/^[a-z]/.test(camel) ? camel : `icon${camel}`}Icon`;
    if (files.has(file) || identifiers.has(identifier)) throw new Error(`Icon name collision for "${label}".`);
    identifiers.add(identifier);
    const svg = svgDocument(content);
    icons.set(label, { file, identifier, svg });
    files.set(file, svg);
  }
  const usedIcons = [...icons].filter(([label]) => grouped.has(label))
    .map(([, icon]) => icon).sort((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : 0);
  const hash = createHash('sha256').update(source).digest('hex');
  const output = [
    '// Generated by npm run generate:languages. Do not edit by hand.',
    `// Source: CodeblockCustomizer/src/Const.ts (SHA-256: ${hash}).`,
    '// See THIRD_PARTY_NOTICES for attribution and license information.',
    ...usedIcons.map((icon) => `import ${icon.identifier} from ${quote(`./${icon.file.slice(4)}`)};`),
    '',
    'export interface LanguageDefinition {',
    '  readonly label: string;',
    '  readonly aliases: readonly string[];',
    '  readonly icon: string | null;',
    '}',
    '',
    'export const languages = {',
    ...languages.flatMap((language) => [
      `  ${/^[a-z_$][a-z0-9_$]*$/i.test(language.id) ? language.id : quote(language.id)}: {`,
      `    label: ${quote(language.label)},`,
      `    aliases: [${language.aliases.map(quote).join(', ')}],`,
      `    icon: ${icons.get(language.label)?.identifier ?? 'null'},`,
      '  },',
    ]),
    '} satisfies Record<string, LanguageDefinition>;',
    '',
  ].join('\n');
  files.set('src/languages.ts', output);
  return {
    files,
    aliasCount: definitions.aliases.size,
    languageCount: languages.length,
    iconCount: icons.size,
  };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const sourcePath = resolve(root, args.find((arg) => arg !== '--check') ?? '.local/CodeblockCustomizer/src/Const.ts');
  const generated = generateLanguageFiles(readFileSync(sourcePath, 'utf8'));
  const iconDirectory = resolve(root, 'src/icons');
  if (existsSync(iconDirectory)) {
    const extra = readdirSync(iconDirectory).filter((name) =>
      name.endsWith('.svg') && !generated.files.has(`src/icons/${name}`));
    if (extra.length) throw new Error(`Unexpected SVG files in src/icons: ${extra.join(', ')}`);
  }
  for (const [path, content] of generated.files) {
    const target = resolve(root, path);
    if (check) {
      if (readFileSync(target, 'utf8') !== content) throw new Error(`Generated file is out of date: ${path}`);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  console.log(`${check ? 'Verified' : 'Generated'} ${generated.languageCount} languages, ${generated.aliasCount} aliases, and ${generated.iconCount} SVGs.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
