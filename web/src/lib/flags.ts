/** Features that can be kept out of sight. Forms is hidden unless NEXT_PUBLIC_FORMS=1, so a demo shows Documents and Search only. */
export const formsEnabled = process.env.NEXT_PUBLIC_FORMS === "1";
