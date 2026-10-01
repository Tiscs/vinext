import { esm, named } from "./mixed.js";

export default function Page() {
  return (
    <div data-testid="cjs-mixed-esm">
      {named}+{esm}
    </div>
  );
}
