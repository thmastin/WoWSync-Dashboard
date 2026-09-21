// Lets `node --test` import the app's .tsx components (Node strips TypeScript types but does not transform JSX).
// A synchronous load hook compiles each .tsx file with the TypeScript compiler that is already a dev dependency
// (JSX -> react/jsx-runtime); nothing else changes and no test dependency is added. Test files stay plain .ts and
// build elements with createElement, then render them to static markup (react-dom/server).
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      const { outputText } = ts.transpileModule(source, {
        fileName: fileURLToPath(url),
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      });
      return { format: "module", source: outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
