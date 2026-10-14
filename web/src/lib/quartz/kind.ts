export const kinds = ['agent', 'key', 'run', 'deploy', 'model'] as const;
export type Kind = (typeof kinds)[number];

/** Reserved hues. Warm means warn or fail: no kind may take either. */
export const reserved = ['warn', 'fail'] as const;
export type Reserved = (typeof reserved)[number];
