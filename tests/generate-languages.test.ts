import { describe, expect, it } from 'vitest';
import { extractDefinitions, generateLanguageFiles } from '../scripts/generate-languages';

const source = `
  export const Languages = { py: 'Python', conflict: 'Primary', abnf: 'ABNF' };
  export const manualLang = { python: 'Python', conflict: 'Manual', go: 'Go' };
  export const Icons = {
    Python: '<path fill="#123456" d="M0 0h32v32H0z"/>',
    Go: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><path d="M0 0h128v128H0z"/></svg>',
    Unused: '<circle cx="16" cy="16" r="8"/>'
  };
`;

describe('CC definition conversion', () => {
  it('groups aliases around canonical IDs and retains the primary table precedence', () => {
    const result = generateLanguageFiles(source);
    const definitions = result.files.get('src/languages.ts')!;
    expect(extractDefinitions(source).aliases.get('conflict')).toBe('Primary');
    expect(definitions).toContain("python: {\n    label: 'Python',\n    aliases: ['py'],\n    icon: pythonIcon,");
    expect(definitions).toContain("abnf: {\n    label: 'ABNF',\n    aliases: [],\n    icon: null,");
    expect(definitions).not.toContain("label: 'Manual'");
    expect(definitions).not.toContain('unusedIcon');
    expect(result.files.has('src/icons/unused.svg')).toBe(true);
  });

  it('preserves SVG colors and coordinate systems inside CC-compatible standalone documents', () => {
    const { files } = generateLanguageFiles(source);
    expect(files.get('src/icons/python.svg')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32"><path fill="#123456" d="M0 0h32v32H0z"/></svg>\n',
    );
    const go = files.get('src/icons/go.svg')!;
    expect(go).toContain('viewBox="0 0 32 32"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">');
    expect(go).not.toContain('width="128"');
    expect(go).not.toContain('height="128"');
  });

  it('does not execute dynamic source expressions or accept remote SVG resources', () => {
    expect(() => generateLanguageFiles(source.replace("py: 'Python'", 'py: getLabel()')))
      .toThrow('Expected static string entries');
    expect(() => generateLanguageFiles(source.replace('<circle cx="16" cy="16" r="8"/>', '<image href="https://example.com/icon.png"/>')))
      .toThrow('external resources');
  });

  it('reports ambiguous filenames instead of overwriting an icon', () => {
    expect(() => generateLanguageFiles(source.replace(
      "Unused: '<circle cx=\"16\" cy=\"16\" r=\"8\"/>'",
      "'Same Name': '<path/>', 'Same-Name': '<path/>'",
    ))).toThrow('Icon name collision');
  });
});
