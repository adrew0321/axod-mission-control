// A "vivid" dark theme for the Monaco viewers (Files tab + Code Diff), matching
// the app palette. `monaco` is the @monaco-editor/react `Monaco` instance passed
// to a beforeMount handler. Typed loosely to avoid importing monaco's types.
export const VIVID_THEME = "vivid-dark";

export function defineVividTheme(monaco: {
  editor: { defineTheme: (name: string, theme: unknown) => void };
}): void {
  monaco.editor.defineTheme(VIVID_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "ff7b72" },
      { token: "string", foreground: "a5d6ff" },
      { token: "comment", foreground: "6e7681", fontStyle: "italic" },
      { token: "number", foreground: "79c0ff" },
      { token: "type", foreground: "d2a8ff" },
      { token: "function", foreground: "d2a8ff" },
      { token: "variable", foreground: "79c0ff" },
    ],
    colors: { "editor.background": "#060810" },
  });
}
