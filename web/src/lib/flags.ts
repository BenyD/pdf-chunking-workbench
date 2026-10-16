/** Features that can be kept out of sight. Forms is hidden unless NEXT_PUBLIC_FORMS=1, so a demo shows Documents and Search only. */
export const formsEnabled = process.env.NEXT_PUBLIC_FORMS === "1";

/**
 * Generative AI is off unless NEXT_PUBLIC_AI=1. Off, the app reads the passages exactly as the rules cut them,
 * meaning search runs on a small open-source model inside the worker (no API call), and no answer is written:
 * the matching passages are the result. On, it adds a model-written context line per passage, figure
 * descriptions and a written answer.
 */
export const aiEnabled = process.env.NEXT_PUBLIC_AI === "1";
