import { describe, expect, it } from 'vitest';
import { parseCodeBlocks, parseInfo } from '../src/codeblock';
import { splitCommands } from '../src/commands';
import { isLanguageEnabled, parseSettings } from '../src/settings';

describe('command blocks', () => {
  it.each(['sh', 'ansi'])('does not pair excluded %s fences or diagnose their parameters', (excluded) => {
    const settings = parseSettings({ languageBlacklist: [excluded] });
    const source = '```sh title:Command\npwd\n```\n```ansi expand:0\nout\n```';
    const result = parseCodeBlocks(source, (language) => isLanguageEnabled(language, settings));
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]?.terminal).toBeUndefined();
    expect(result.blocks[1]?.commandFrom).toBeUndefined();
    expect(result.diagnostics).toHaveLength(excluded === 'ansi' ? 0 : 1);
    const metadata = parseCodeBlocks(source.replace('title:Command', 'user:root'),
      (language) => isLanguageEnabled(language, settings));
    expect(metadata.blocks[0]?.terminal).toEqual({ user: 'root' });
  });

  it('does not pair across excluded fences while retaining them for native block matching', () => {
    const source = '```sh\npwd\n```\n```dataview\nTABLE\n```\n```ansi\nout\n```';
    const result = parseCodeBlocks(source, (language) => isLanguageEnabled(language, parseSettings(null)));
    expect(result.blocks.map((block) => block.language)).toEqual(['sh', 'dataview', 'ansi']);
    expect(result.blocks[0]?.terminal).toBeUndefined();
    expect(result.blocks[2]?.commandFrom).toBeUndefined();
  });

  it('normalizes quoted metadata and directory aliases without activating ordinary blocks', () => {
    const info = parseInfo('bash USER="root" host:server cwd:/old directory:"/work tree" dir:/last');
    expect(info.context).toEqual({ user: 'root', host: 'server', cwd: '/last' });
    expect(parseCodeBlocks('```bash title:Only\npwd\n```').blocks[0]?.terminal).toBeUndefined();
    expect(parseCodeBlocks('```js user:root\nrun()\n```').blocks[0]?.terminal).toBeUndefined();
    expect(parseCodeBlocks('```sh pwd:"/work tree"\npwd\n```').blocks[0]?.terminal).toEqual({ cwd: '/work tree' });
    expect(parseCodeBlocks('```sh user:""\npwd\n```').blocks[0]?.terminal).toEqual({ user: '' });
  });

  it.each(['sh', 'bash', 'zsh', 'csh', 'fish'])('pairs adjacent %s and ANSI blocks with a shared output', (language) => {
    const { blocks } = parseCodeBlocks(`\`\`\`${language}\npwd\nuname -s\n\`\`\`\n\`\`\`ansi expand\nLinux\n\`\`\``);
    expect(blocks[0]?.terminal?.output).toBe(blocks[1]);
    expect(blocks[1]?.commandFrom).toBe(blocks[0]?.from);
    expect(blocks[0]?.text).toBe('pwd\nuname -s');
    expect(blocks[1]?.fold).toBe(false);
  });

  it.each([
    ['```sh\npwd\n```\n\n```ansi\nout\n```', false],
    ['```sh\npwd\n```\ntext\n```ansi\nout\n```', false],
    ['> ```sh\n> pwd\n> ```\n> ```ansi\n> out\n> ```', true],
    ['> ```sh\n> pwd\n> ```\n```ansi\nout\n```', false],
    ['- ```sh\n  pwd\n  ```\n- ```ansi\n  out\n  ```', false],
    ['- item\n\n  ```sh\n  pwd\n  ```\n  ```ansi\n  out\n  ```', true],
  ])('pairs only immediate siblings in the same Markdown container: %j', (source, paired) => {
    const { blocks } = parseCodeBlocks(source);
    expect(blocks[0]?.terminal?.output !== undefined).toBe(paired);
  });

  it.each([
    ['first\nsecond', ['first', 'second']],
    ['npm run build \\\n  --mode production\npwd', ['npm run build \\\n  --mode production', 'pwd']],
    ['echo two \\\\\nnext', ['echo two \\\\', 'next']],
    ['printf \\', ['printf \\']],
    ['\nfirst\n\nsecond\n\n', ['first', 'second']],
    [' \n\n', []],
  ])('splits commands and preserves continuations in %j', (text, expected) => {
    expect(splitCommands(text).map(({ from, to }) => text.slice(from, to))).toEqual(expected);
  });
});

describe('header options', () => {
  it.each([
    ['python title:"サンプル コード"', 'python', 'サンプル コード'],
    ["ts file:'src/my file.ts'", 'ts', 'src/my file.ts'],
    ['bash title="Install packages"', 'bash', 'Install packages'],
    ['js title:"Ignored" file:src/main.js', 'js', 'src/main.js'],
    ['JS file:src/main.js title:"Ignored"', 'js', 'src/main.js'],
    ['title:"No language"', '', 'No language'],
    ['json', 'json', ''],
    ['', '', ''],
    ['sh prompt:"user title:ignored" title:"Real title"', 'sh', 'Real title'],
    ['py title:"Say \\"Hello\\"" ignored', 'py', 'Say "Hello"'],
    ['text file:C:\\work\\notes.txt', 'text', 'C:\\work\\notes.txt'],
  ])('parses %s', (source, language, title) => {
    expect(parseInfo(source)).toMatchObject({ language, title, diagnostics: [] });
  });

  it.each([
    ['', false], ['js', false], ['  js \t ', false],
    ['js title:""', true], ['file:""', true], ['js fold', true],
    ['js expand', true], ['unfold:3', true], ['js header-style:note', true],
    ['js custom:value', true],
  ])('tracks explicit parameters independently of their values in %j', (info, hasParameters) => {
    expect(parseInfo(info).hasParameters).toBe(hasParameters);
    expect(parseCodeBlocks(`\`\`\`${info}\nrun()\n\`\`\``).blocks[0]?.hasParameters).toBe(hasParameters);
  });

  it('reports an unfinished quoted option without inventing a title', () => {
    const result = parseInfo('js title:"unfinished');
    expect(result.title).toBe('');
    expect(result.diagnostics).toEqual(['Unclosed quote in "title" option.']);
  });

  it.each([
    ['python fold', 'python', true],
    ['python expand', 'python', false],
    ['python unfold', 'python', false],
    ['FOLD title:"Example"', '', true],
    ['expand', '', false],
    ['unfold', '', false],
    ['js fold expand', 'js', false],
    ['js unfold fold', 'js', true],
  ])('parses the last standalone folding option in %s', (source, language, fold) => {
    expect(parseInfo(source)).toMatchObject({ language, fold, diagnostics: [] });
  });

  it('does not interpret option values as folding flags and reports valued folding options', () => {
    expect(parseInfo('js title:"fold expand unfold" prompt:fold').fold).toBeUndefined();
    const invalid = parseInfo('js fold:false');
    expect(invalid.fold).toBeUndefined();
    expect(invalid.diagnostics).toEqual(['The "fold" option does not take a value.']);
  });

  it.each([
    ['python expand:5', 'python', 5],
    ['expand:3 title:"Preview"', '', 3],
    ['JS UNFOLD="2"', 'js', 2],
    ['js fold expand:7', 'js', 7],
  ])('parses a partial preview in %s', (source, language, previewLines) => {
    expect(parseInfo(source)).toMatchObject({ language, fold: false, previewLines, diagnostics: [] });
  });

  it('lets later folding options replace partial previews without interpreting title values', () => {
    expect(parseInfo('js expand:2 fold')).toMatchObject({ fold: true, diagnostics: [] });
    expect(parseInfo('js expand:2 fold').previewLines).toBeUndefined();
    expect(parseInfo('js expand:2 unfold')).toMatchObject({ fold: false, diagnostics: [] });
    expect(parseInfo('js expand:2 unfold').previewLines).toBeUndefined();
    expect(parseInfo('js title:"expand:5"').previewLines).toBeUndefined();
    expect(parseCodeBlocks('```js expand:5\nrun()\n```').blocks[0]?.previewLines).toBe(5);
  });

  it.each(['0', '-1', '1.5', 'Infinity', '9007199254740992', ''])(
    'reports invalid partial preview counts: %j', (count) => {
      const info = parseInfo(`js expand:${count}`);
      expect(info.previewLines).toBeUndefined();
      expect(info.diagnostics).toEqual([expect.stringContaining('positive whole number')]);
    },
  );

  it.each([
    ['python header-style:warning file:main.py', 'python', 'main.py', 'warning'],
    ['JS HEADER-STYLE="ERROR" title:"Example"', 'js', 'Example', 'error'],
    ['header-style:custom-alert', '', '', 'custom-alert'],
  ])('parses a callout header style in %s', (source, language, title, headerStyle) => {
    expect(parseInfo(source)).toMatchObject({ language, title, headerStyle, diagnostics: [] });
  });

  it.each(['header-style:', 'header-style:"warning red"', 'header-style:"<warning>"'])(
    'reports an invalid style without discarding the title: %s', (option) => {
      const result = parseInfo(`js title:Example ${option}`);
      expect(result).toMatchObject({ language: 'js', title: 'Example' });
      expect(result.headerStyle).toBeUndefined();
      expect(result.diagnostics).toEqual([expect.stringContaining('Invalid "header-style" option')]);
    },
  );
});

describe('Markdown code blocks', () => {
  it('propagates explicit folding choices without inventing a choice for unmarked blocks', () => {
    const source = ['fold', 'expand', 'unfold', ''].map((option) => `\`\`\`js ${option}\nrun()\n\`\`\``).join('\n\n');
    expect(parseCodeBlocks(source).blocks.map((block) => block.fold)).toEqual([true, false, false, undefined]);
  });

  it.each([
    ['```js\n```', 0],
    ['```js\n\n```', 1],
    ['```js\nfirst()\n\nlast()\n\n```', 4],
    ['```js\nfirst()\n', 2],
    ['```js', 0],
    ['> ```js\r\n> first()\r\n> \r\n> ```', 2],
  ])('counts body lines without counting fences in %j', (source, lineCount) => {
    expect(parseCodeBlocks(source).blocks[0]?.lineCount).toBe(lineCount);
  });

  it('propagates header styles and reports invalid values at the fence line', () => {
    const source = '```py header-style:NOTE\nprint(1)\n```\n\n```js header-style:"bad style"\nrun()\n```';
    const { blocks, diagnostics } = parseCodeBlocks(source);
    expect(blocks[0]).toMatchObject({ headerStyle: 'note', text: 'print(1)' });
    expect(blocks[1]!.headerStyle).toBeUndefined();
    expect(diagnostics).toEqual([{ line: 4, message: expect.stringContaining('Invalid "header-style" option') }]);
  });

  it('keeps fenced examples and indented code from becoming extra headers', () => {
    const source = [
      '    indented code', '', '````markdown title:"Example"',
      '```js title:"Not a block"', 'alert(1)', '```', '````',
      '', '~~~py file:main.py', 'print(1)', '~~~',
    ].join('\n');
    const { blocks, diagnostics } = parseCodeBlocks(source);
    expect(diagnostics).toEqual([]);
    expect(blocks.map(({ language, title, startLine, endLine }) => ({ language, title, startLine, endLine }))).toEqual([
      { language: 'markdown', title: 'Example', startLine: 2, endLine: 6 },
      { language: 'py', title: 'main.py', startLine: 8, endLine: 10 },
    ]);
  });

  it.each(['\n', '\r\n'])('extracts code from quotes and lists with %j newlines', (newline) => {
    const source = [
      '> [!note]', '> ```js title:"Quote"', '> first()', '> second()', '> ```',
      '', '- Example', '', '  ```sh title:"List"', '  echo one', '  echo two', '  ```',
    ].join(newline);
    const { blocks } = parseCodeBlocks(source);
    expect(blocks.map(({ title, text, from }) => ({ title, text, from }))).toEqual([
      { title: 'Quote', text: 'first()\nsecond()', from: source.indexOf('> ```') },
      { title: 'List', text: 'echo one\necho two', from: source.indexOf('  ```') },
    ]);
  });

  it('ignores YAML frontmatter and preserves source line positions with CRLF', () => {
    const source = '\uFEFF---\r\nexample: |\r\n  ```js\r\n---\r\n```py title:"Real"\r\nprint(1)\r\n```\r\n';
    const { blocks } = parseCodeBlocks(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ language: 'py', title: 'Real', startLine: 4, endLine: 6, text: 'print(1)' });
    expect(source.slice(blocks[0]!.from, blocks[0]!.from + 5)).toBe('```py');
  });

  it('supports an unfinished fence while editing and reports its option error on the correct line', () => {
    const result = parseCodeBlocks('Intro\n\n```ts title:"unfinished\nconst x = 1;');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({ startLine: 2, title: '', text: 'const x = 1;' });
    expect(result.diagnostics).toEqual([{ line: 2, message: 'Unclosed quote in "title" option.' }]);
  });
});
