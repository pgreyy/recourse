/** A browser coming back from PayPal goes to the screen; API clients (Postman) keep getting JSON. */
export const wantsPage = (req: { accepts(types: string[]): string | false }) => req.accepts(['json', 'html']) === 'html';
