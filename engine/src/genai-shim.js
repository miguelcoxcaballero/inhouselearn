// pi-ai solo usa de @google/genai unos enums de texto (FinishReason, ThinkingLevel...)
// en los helpers de Google. El SDK entero pesa demasiado para el navegador, así
// que el build lo sustituye por esto: cada miembro del enum vale su propio nombre,
// que es lo mismo que hace el SDK.
const stringEnum = () => new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) });

export const FinishReason = stringEnum();
export const FunctionCallingConfigMode = stringEnum();
export const ThinkingLevel = stringEnum();
