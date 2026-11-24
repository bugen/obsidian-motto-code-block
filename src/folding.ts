import type { CodeBlock } from './codeblock';
import { shouldShowHeader, type FoldState, type MottoSettings } from './settings';

export interface OutputState {
  open: boolean;
  fullyExpanded: boolean;
}

export type NoteFoldAction = 'fold-blocks' | 'expand-blocks' | 'close-outputs' | 'open-outputs' | 'reset-folds';

export function hasFoldableHeader(block: CodeBlock, settings: MottoSettings): boolean {
  return !(settings.commandBlocks && block.commandFrom !== undefined) &&
    shouldShowHeader(settings.headerDisplay, block.hasParameters);
}

export function noteFoldOverride(block: CodeBlock, settings: MottoSettings, action: NoteFoldAction): FoldState | undefined {
  if (!hasFoldableHeader(block, settings)) return;
  if (action === 'fold-blocks') return 'folded';
  if (action === 'expand-blocks' || (action === 'open-outputs' && settings.commandBlocks && block.terminal?.output)) {
    return 'expanded';
  }
}

export function noteOutputOverride(action: NoteFoldAction): OutputState | undefined {
  if (action === 'open-outputs') return { open: true, fullyExpanded: true };
  if (action === 'close-outputs') return { open: false, fullyExpanded: false };
}

export function initialOutputState(block: CodeBlock): OutputState {
  return { open: block.fold === false, fullyExpanded: false };
}

export function outputPreviewLineCount(block: CodeBlock, state: OutputState): number | undefined {
  return !state.fullyExpanded && block.previewLines !== undefined && block.previewLines < block.lineCount
    ? block.previewLines : undefined;
}

export function nextOutputState(block: CodeBlock, state: OutputState): OutputState {
  if (state.open && state.fullyExpanded) {
    const preview = { open: true, fullyExpanded: false };
    if (outputPreviewLineCount(block, preview) !== undefined) return preview;
  }
  return { ...state, open: !state.open };
}

export function previewLineCount(block: CodeBlock, settings: MottoSettings): number {
  return block.previewLines ?? settings.partialFoldLines;
}

export function resolveFoldState(block: CodeBlock, settings: MottoSettings, override?: FoldState): FoldState {
  if (!shouldShowHeader(settings.headerDisplay, block.hasParameters)) return 'expanded';
  const state = override ?? (block.previewLines !== undefined ? 'partial'
    : block.fold !== undefined ? block.fold ? 'folded' : 'expanded' : settings.defaultFoldState);
  return state === 'partial' && block.lineCount <= previewLineCount(block, settings) ? 'expanded' : state;
}

export function nextFoldState(block: CodeBlock, settings: MottoSettings, current: FoldState): FoldState {
  if (current !== 'expanded') return 'expanded';
  return resolveFoldState(block, settings) === 'partial' ? 'partial' : 'folded';
}
