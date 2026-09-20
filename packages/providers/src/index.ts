export type { NextOptions, Provider, VisionProvider } from './provider';
export { createProvider, createVisionProvider } from './provider';
export { LocalProvider, localAction, NO_ACTION, PLACEHOLDER_CONFIDENCE } from './local';
export { OpenAICompatProvider, cacheKey, memoryRelaxStore, paramFromMessage, readStream } from './openai-compat';
export type { OpenAICompatOptions, OutputMode, ReasoningEffort, RelaxStore } from './openai-compat';
export { RaceProvider } from './race';
export type { RaceAnswer, RaceAttempt, RaceOptions } from './race';
export { extractCandidates, candidatesFrom, notesAsSources, CANDIDATE_LABEL } from './local/candidates';
export type { Candidate, CandidateKind, Source } from './local/candidates';
