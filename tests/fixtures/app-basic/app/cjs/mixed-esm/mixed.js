// A project module that mixes a free CommonJS export with an ESM export. It
// still needs vite-plugin-commonjs to turn `exports.named` into an export.
exports.named = "cjs";
export const esm = "esm";
