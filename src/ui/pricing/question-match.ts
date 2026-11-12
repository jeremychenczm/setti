const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]{4,}/gu) ?? []);

/**
 * Which line one of Setti's questions is about: the one whose name shares the
 * most words with it, when exactly one line does. A question that names no line,
 * or names several equally, stands on its own rather than under a guessed row.
 */
export function matchQuestion(question: string, names: readonly string[]): number | null {
  const asked = words(question);
  const scores = names.map((name) => [...words(name)].filter((word) => asked.has(word)).length);
  const best = Math.max(0, ...scores);
  return best >= 1 && scores.filter((score) => score === best).length === 1 ? scores.indexOf(best) : null;
}
