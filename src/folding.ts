import type { CodeBlock } from './codeblock';
import { shouldShowHeader, type FoldState, type MottoSettings } from './settings';

export interface OutputState {
  open: boolean;
  fullyExpanded: boolean;
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
