import { z } from 'zod';

// Answers are parsed one at a time so an unexpected shape in one question does
// not throw away the others.
const unit = z.number().min(0).max(1);
export const NoulAnswerSchema = z.looseObject({ type: z.literal('noul'), noul: unit });
export const ChoiceAnswerSchema = z.looseObject({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: unit,
  probabilities: z.record(z.string(), unit),
});

export type NoulAnswer = z.infer<typeof NoulAnswerSchema>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type Answers = Record<string, unknown>;

const ResultSchema = z.looseObject({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
});

// The REST endpoint wraps the model output in Cloudflare's v4 envelope.
const EnvelopeSchema = z.looseObject({
  success: z.boolean().optional(),
  errors: z.array(z.looseObject({ code: z.number().optional(), message: z.string().optional() })).optional(),
  result: ResultSchema.nullish(),
});

export type ParsedJev = { ok: true; answers: Answers } | { ok: false; error: string };

export function parseJevResponse(data: unknown): ParsedJev {
  const env = EnvelopeSchema.safeParse(data);
  if (!env.success) return { ok: false, error: `unexpected body (${env.error.issues[0]?.message ?? 'schema mismatch'})` };
  if (env.data.success === false || (env.data.errors?.length ?? 0) > 0) {
    const messages = (env.data.errors ?? []).map((e) => e.message ?? String(e.code ?? 'error'));
    return { ok: false, error: `cloudflare: ${messages.join('; ') || 'success=false'}` };
  }
  if (env.data.result) return { ok: true, answers: env.data.result.answers };
  // A Worker binding or proxy may hand back the bare model output.
  const bare = ResultSchema.safeParse(data);
  if (bare.success) return { ok: true, answers: bare.data.answers };
  return { ok: false, error: 'no answers in the reply' };
}

export function noul(answers: Answers, key: string): number | null {
  const a = NoulAnswerSchema.safeParse(answers[key]);
  return a.success ? a.data.noul : null;
}

export function choice(answers: Answers, key: string): ChoiceAnswer | null {
  const a = ChoiceAnswerSchema.safeParse(answers[key]);
  return a.success ? a.data : null;
}
