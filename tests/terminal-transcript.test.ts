import { describe, expect, it } from 'vitest';
import { parseCodeBlocks } from '../src/codeblock';
import {
  compilePromptPatterns, createPromptDetector, DEFAULT_TERMINAL_PROMPT_PATTERNS, type PromptDetector,
} from '../src/terminal-prompt';
import { formatTerminalTranscript, parseTerminalTranscript } from '../src/terminal-transcript';

function entries(text: string, detect?: PromptDetector) {
  const result = parseTerminalTranscript(text, detect);
  if ('error' in result) throw new Error(result.error);
  return result.entries;
}

describe('terminal transcript parsing', () => {
  it('handles ANSI prompts, changing directories and environment tags, without splitting log lines', () => {
    const raw = '\x1b[32m/home/demo\x1b[0m';
    const parsed = entries([
      '\x1b[32mdemo@host:~$\x1b[0m pwd',
      raw, '', '  indented', 'INFO: demo@host:~$ not a command', 'total $ 100',
      'demo@host:~$ cd work',
      '(.venv) [dev] demo@host:~/work$ ls',
      'result',
      'demo@host:~/work$',
    ].join('\r\n') + '\r\n');
    expect(parsed.map(({ command, output }) => [command, output])).toEqual([
      ['pwd', [raw, '', '  indented', 'INFO: demo@host:~$ not a command', 'total $ 100']],
      ['cd work', []], ['ls', ['result']],
    ]);
    expect(parsed[2]?.prompt).toMatchObject({
      text: '(.venv) [dev] demo@host:~/work$', context: { user: 'demo', host: 'host', cwd: '~/work' },
    });
  });

  it('accepts contiguous anchors with variable decoration, but does not learn from approximate matches', () => {
    const parsed = entries([
      '~/projects/repo [main] $ pwd',
      '~/projects/repo [testing] $ ls',
      'INFO: ~/projects/repo [testing] $ log data',
      '~/projects/repo [release] $ echo done',
    ].join('\n'));
    expect(parsed.map(({ command, output }) => [command, output])).toEqual([
      ['pwd', []], ['ls', ['INFO: ~/projects/repo [testing] $ log data']], ['echo done', []],
    ]);
  });

  it.each(['auto', 'bash'] as const)('handles angle-bracket tags in Linux transcripts (%s)', (mode) => {
    const parsed = entries([
      '<SITE> demo@host:~/work$ ./service.sh start',
      'starting ...',
      '',
      '<SITE> demo@host:~/work$ ./service.sh  check',
      'result',
      '<OTHER> demo@host:~/work/logs$ touch marker',
    ].join('\n'), createPromptDetector([], mode));
    expect(parsed.map(({ prompt, command, output }) => [prompt.language, command, output])).toEqual([
      ['bash', './service.sh start', ['starting ...', '']],
      ['bash', './service.sh  check', ['result']],
      ['bash', 'touch marker', []],
    ]);
    expect(parsed[2]?.prompt.context?.cwd).toBe('~/work/logs');
  });

  it('uses the selected shell for ambiguous prompts and does not search beyond a recognized incompatible prompt', () => {
    const text = 'custom> workspace$ pwd';
    expect(entries(text)[0]).toMatchObject({ command: 'workspace$ pwd', prompt: { language: 'powershell' } });
    expect(entries(text, createPromptDetector([], 'bash'))[0]).toMatchObject({ command: 'pwd', prompt: { language: 'bash' } });
    expect(parseTerminalTranscript('PS C:\\work> Write-Output $ text', createPromptDetector([], 'bash')))
      .toEqual({ error: 'missing-prompt' });
    expect(parseTerminalTranscript('demo@host:~$ echo > file', createPromptDetector([], 'powershell')))
      .toEqual({ error: 'missing-prompt' });
  });

  it('matches common Bash, Zsh and PowerShell prompts, preserving literal percent signs in Markdown', () => {
    const { patterns, invalid } = compilePromptPatterns(DEFAULT_TERMINAL_PROMPT_PATTERNS.map(({ source }) => source));
    expect(invalid).toEqual([]);
    const transcript = [
      'dev@gateway:~$ ssh node',
      'dev@node:~/src$ pwd',
      '(PROD) [dev@node ~/src]$ ls',
      'bash-5.2# whoami',
      'dev@laptop my folder % echo ready',
      '100% complete',
      'laptop% ls',
      'PS C:\\work> pwd',
    ].join('\n');
    const parsed = entries(transcript, createPromptDetector(patterns));
    expect(parsed.map(({ prompt, command }) => [prompt.language, prompt.text, command])).toEqual([
      ['bash', 'dev@gateway:~$', 'ssh node'],
      ['bash', 'dev@node:~/src$', 'pwd'],
      ['bash', '(PROD) [dev@node ~/src]$', 'ls'],
      ['bash', 'bash-5.2#', 'whoami'],
      ['zsh', 'dev@laptop my folder %', 'echo ready'],
      ['zsh', 'laptop%', 'ls'],
      ['powershell', 'PS C:\\work>', 'pwd'],
    ]);
    expect(parsed[4]?.output).toEqual(['100% complete']);
    const { blocks, diagnostics } = parseCodeBlocks(formatTerminalTranscript(parsed, false));
    expect(diagnostics).toEqual([]);
    expect(blocks.filter(({ language }) => language === 'zsh').map(({ terminal }) => terminal?.promptText))
      .toEqual(['dev@laptop my folder %', 'laptop%']);
    const redirected = 'laptop% echo > file';
    expect(entries(redirected, createPromptDetector(patterns, 'bash'))[0]?.command).toBe('echo > file');
    expect(parseTerminalTranscript(redirected, createPromptDetector(patterns, 'powershell')))
      .toEqual({ error: 'missing-prompt' });
  });

  it.each([
    ['demo@host:~$ echo \\\n>   hello\nhello\ndemo@host:~$ pwd', 'echo \\\n  hello', 'bash'],
    ['PS C:\\work> Write-Output `\n>>   hello\nhello\nPS C:\\work\\logs> pwd', 'Write-Output `\n  hello', 'powershell'],
  ])('keeps continuation lines with their commands', (text, command, language) => {
    const parsed = entries(text);
    expect(parsed[0]).toMatchObject({ command, output: ['hello'], prompt: { language } });
    expect(parsed[1]?.command).toBe('pwd');
  });

  it('skips canceled commands and their output without filtering output from other commands', () => {
    const result = parseTerminalTranscript([
      '$ ^C', '$ ls', 'file', '^C', '$ cd ^C   ', 'discarded with canceled input',
      '$ echo "text ^C"', 'text ^C', '$ cd \u0003', '$ printf \\' , '> more ^C', '$ pwd', '/work', '$',
    ].join('\n'), undefined, ['^C']);
    expect(result).toMatchObject({ entries: [
      { command: 'ls', output: ['file', '^C'] },
      { command: 'echo "text ^C"', output: ['text ^C'] },
      { command: 'pwd', output: ['/work'] },
    ] });
    expect(parseTerminalTranscript('$ ^C\n$ cd ^C\n$', undefined, ['^C']))
      .toEqual({ error: 'all-commands-ignored' });
  });

  it('reports invalid input and supports custom or injected prompt detectors without Obsidian', () => {
    expect(parseTerminalTranscript('output\n$ pwd')).toEqual({ error: 'missing-prompt' });
    expect(parseTerminalTranscript('(.venv) demo@host:~$\n')).toEqual({ error: 'missing-command' });
    expect(parseTerminalTranscript('$\noutput\n$ pwd')).toEqual({ error: 'output-before-command' });
    const { patterns, invalid } = compilePromptPatterns(['dev:[A-Z,]+\\$', '', '(', 'remote!\\$']);
    expect(invalid).toEqual([3]);
    expect(entries('dev:ABC,D$ pwd\nremote!$ ls', createPromptDetector(patterns)).map((entry) => entry.command))
      .toEqual(['pwd', 'ls']);
    const detect: PromptDetector = (line) => line.startsWith('!')
      ? { prompt: { text: '!', language: 'bash', marker: '$' }, command: line.slice(1) } : undefined;
    expect(entries('!pwd\n/foo\n!ls', detect).map((entry) => entry.command)).toEqual(['pwd', 'ls']);
  });

  it('keeps parsing strong matches after many ambiguous candidates without dropping output', () => {
    const nearMatch = `${'a'.repeat(160)} [other] $ log line`;
    const logs = Array.from({ length: 10_000 }, () => `INFO: ${nearMatch}`);
    const original = `${'a'.repeat(160)} [base] $`;
    const parsed = entries([`${original} pwd`, ...logs, nearMatch, `${original} ls`].join('\n'));
    expect(parsed.map((entry) => entry.command)).toEqual(['pwd', 'ls']);
    expect(parsed[0]?.output).toEqual([...logs, nearMatch]);
  });
});

it('round-trips adjacent command/output fences in both ANSI modes, including fence content', () => {
  const outputs = ['\x1b[31mred\x1b[0m', '```', 'after', ''];
  const parsed = entries([
    'demo@host:~/`folder`$ pwd',
    ...outputs,
    'demo@host:~$ cd work',
    'demo@host:~/work$ ls',
  ].join('\n'));
  for (const keepAnsi of [true, false]) {
    const markdown = formatTerminalTranscript(parsed, keepAnsi);
    const { blocks, diagnostics } = parseCodeBlocks(markdown);
    expect(diagnostics).toEqual([]);
    expect(blocks.map((block) => [block.language, block.text, block.terminal?.session])).toEqual([
      ['bash', 'pwd', 'first'],
      [keepAnsi ? 'ansi' : 'plaintext', [keepAnsi ? outputs[0] : 'red', ...outputs.slice(1)].join('\n'), undefined],
      ['bash', 'cd work', 'middle'], ['bash', 'ls', 'last'],
    ]);
    expect(blocks[0]?.terminal?.cwd).toBe('~/`folder`');
  }
});

it.each([true, false])('keeps literal prompts on both sides of an SSH command (keep ANSI=%s)', (keepAnsi) => {
  const { patterns } = compilePromptPatterns([String.raw`^\([A-Z]+\)[ \t]+\[[A-Za-z0-9._-]+@[A-Za-z0-9._-]+[ \t]+[^\]\r\n]+\]\$`]);
  const local = '<SITE> demo@gateway:~$';
  const remote = '(PROD) [dev@node-01 ~]$';
  const next = '(PROD) [dev@node-01 ~/my "dir"]$';
  const parsed = entries([
    `${local} ssh node-01`, 'Last login: yesterday',
    `\x1b[32m${remote}\x1b[0m pwd`, '/home/dev',
    `${next} ls`, 'notes.txt',
  ].join('\n'), createPromptDetector(patterns, 'bash'));
  const markdown = formatTerminalTranscript(parsed, keepAnsi);
  expect(markdown).toContain(`prompt-text:"${remote}" prompt-display:hide`);
  const { blocks, diagnostics } = parseCodeBlocks(markdown);
  expect(diagnostics).toEqual([]);
  expect(blocks.filter((block) => block.terminal).map((block) => [
    block.text, block.terminal?.promptText, block.terminal?.output?.text,
  ])).toEqual([
    ['ssh node-01', local, 'Last login: yesterday'],
    ['pwd', remote, '/home/dev'],
    ['ls', next, 'notes.txt'],
  ]);
});
