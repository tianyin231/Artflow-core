import { CoverTemplateId, getCoverTemplate } from './templates';
import { getTransition, TransitionId } from './transitions';

export interface WorkflowRenderOptions {
  transition?: TransitionId;
  coverTemplate?: CoverTemplateId;
  subtitles?: 'none' | 'srt' | 'ass';
}

export function validateRenderOptions(value: unknown): WorkflowRenderOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Render options must be an object');
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some((key) => !['transition', 'coverTemplate', 'subtitles'].includes(key))) {
    throw new Error('Unknown render option');
  }
  if (options.transition !== undefined && (typeof options.transition !== 'string' || !getTransition(options.transition))) {
    throw new Error('Unknown transition');
  }
  if (options.coverTemplate !== undefined && (typeof options.coverTemplate !== 'string' || !getCoverTemplate(options.coverTemplate))) {
    throw new Error('Unknown cover template');
  }
  if (options.subtitles !== undefined && (typeof options.subtitles !== 'string' || !['none', 'srt', 'ass'].includes(options.subtitles))) {
    throw new Error('Unknown subtitle format');
  }
  return {
    ...(options.transition === undefined ? {} : { transition: options.transition as TransitionId }),
    ...(options.coverTemplate === undefined ? {} : { coverTemplate: options.coverTemplate as CoverTemplateId }),
    ...(options.subtitles === undefined ? {} : { subtitles: options.subtitles as WorkflowRenderOptions['subtitles'] }),
  };
}
