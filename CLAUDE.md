# Project rules

These are the binding rules for working in this repo. They were imported
from `.cursor/rules/*.mdc` so Claude reads them automatically.

## General guidelines

- The code automatically updates on save, so do not ever run commands to rerun the site.
- Don't run shell commands when you need to create or move small code files. Use tool calls. Use tool calls to make files within folders — you don't need to make the folder, just make the file, the folder will be created automatically.
- If you need to add a dependency, don't just edit `package.json`. Use `yarn add` so you get the latest version, unless the user specifies a version.
- Use tool calls to read files and directories instead of running `ls`, `dir`, etc.

## Coding styles

- Times should almost always be in milliseconds; assume milliseconds if not told otherwise.
- Don't make functions that will never be reused and are short. If under 5 lines and not reused, don't create it unless explicitly told to.
- Comments are used sparingly and only when required to explain what's being done. A comment that just restates the function name is forbidden.
- Comments go on the line BEFORE the statement, never trailing the semicolon.
- Use `undefined`, not `null`.
- Almost never check for `undefined`/`null` specifically — just check truthiness.
- When a function has more than one primitive parameter that could be confused (e.g. start and end time), put them inside a single object parameter called `config`.
- Never use return codes — always throw. Include context (expected vs actual). If values could be huge (e.g. file parsing), limit to ~500 characters.
- Use double quotes, not single quotes.
- Never use the ternary operator. Convert `x ? y : z` into `x && y || z`.
- Never use the non-null assertion operator (`!`). Check the value; if needed in nested closures, copy into a `const` to preserve narrowed type.
- Errors use template strings that include the actual offending value and the expected one: `throw new Error(\`Expected X, was \${y}\`);`
- Don't use `switch`. Use `if/else`.
- Don't use `!` to access a value from a `Map`. Use `get` + initialize-if-undefined + `set`.
- Sort with `import { sort } from "socket-function/src/misc";` — `sort<T>(arr: T[], sortKey: (obj: T) => unknown)`.
- Prefer early `return` over deep `else`. Handle error cases, warn/throw, then return. The main case should be at the bottom, not nested.
- Use functions to remove duplication only when something is actually duplicated.
- Don't recreate collections or URL parameters — import them.
- Do not redefine types. Import them.
- Do not annotate types that can be inferred.
- Constants that might need reconfiguration go near the top of the file under the imports, not buried in functions.
- Never use environment variables. Configuration goes on disk or via CLI args.
- Never use inline styles. Always use the `css` helper.
- Don't use `as any`.
- When fetch returns `any`, cast it to the real type rather than leaving it as `any`. Same for any deserialized value.
- DO NOT redeclare constants or types — IMPORT THEM.
- Don't try/catch for no reason. If you can't handle the exception, let it throw.
- For input events, always use `event.currentTarget`.
- Use `ref={elem => …}` callbacks. NEVER use `React.createRef`.
- NEVER render images with a fixed width AND height. This stretches or crops them. Set only width OR height.
- Avoid callback hell with `import { PromiseObj } from "socket-function/src/misc";` — wrap event callbacks in a `PromiseObj` and await it.
- `import { keyBy, keyByArray } from "socket-function/src/misc";` for building lookups.
- Never use `alert`. Throw instead.

## MobX state

We use MobX. Components store local state in a field called `synced`, which is an `observable`. Never use `Component.state`. Components need the `@observer` decorator.

```tsx
import preact from "preact";
import { observable } from "mobx";
import { observer } from "sliftutils/render-utils/observer";

@observer
class Example extends preact.Component {
    synced = observable({
        x: 0,
    });

    render() {
        return <div>
            <button onClick={() => this.synced.x++}>
                Click me
            </button>
            <p>
                {this.synced.x}
            </p>
        </div>;
    }
}
```

## Styling and CSS

- Never use `em` or `rem`. Use `px` or `vw`/`vh`/`%`.
- Don't add font colors / aesthetics / `fontSize` beyond `hbox`/`vbox`/`pad2` unless asked. If you think styling could help, *tell the user* — don't add it unprompted.
- Never use `h1`/`h2`/`h3` etc. — set the font size explicitly instead.
- Don't use `fillWidth` where `flexGrow(1)` would do.
- Add very little styling (colors, rounding, etc.) unless asked.

### The `css` helper

All styling goes through the `css` helper.

```tsx
<div className={css.width(100).height(50)}>…</div>
```

Chains of properties are fine across two lines:

```tsx
className={css.size(100, 100).hbox(4)
    .hsl(0, 50, 50).borderRadius(4)
}
```

Conditionals come after, never as a ternary:

```tsx
className={css
    .size(100, 100).hbox(4)
    + (isDimmed && css.opacity(0.5))
}
```

### Aliases

Non-call aliases (chainable): `relative`, `absolute`, `fixed`, `wrap`, `marginAuto`, `fillBoth`, `fillWidth`, `fillHeight`, `flexShrink0`, `ellipsis`, `overflowAuto`, `overflowHidden`.

Call aliases: `hbox(gap, rowGap?)`, `vbox(gap, columnGap?)`, `pad2(value, vertical?)`, `hsl/hsla(...)`, `hslhover/hslahover`, `bord/bord2`, `hslcolor/hslacolor`, `size(w, h)`, `pos(x, y)`.

Use `css.button` to make a *non-button* feel like a button (hover background + pointer cursor) — only when a background color is set, and never on actual `<button>`/`<Button>`.

Prefer `hbox`/`vbox` for spacing between elements over margins.

### Animations

Keyframes go in a `<style>` tag:

```tsx
<style>{`
    @keyframes spinner-ring {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
`}</style>
```

## Components

### Anchor

`Anchor` is the `<a>` for navigation tied to `URLParam`:

```tsx
<Anchor params={[[todolistURL, listKey]]}>
    {list.name}
</Anchor>
```

`URLParam` stores a value in the URL. Second argument is the default (number, string, or object). Use `.value` to get/set.

```ts
const todolistURL = new URLParam("todolist", "");
```

### InputLabel

Use `InputLabel` / `InputLabelURL` for inputs:

```tsx
<InputLabelURL
    label="Show Previous Video"
    checkbox
    persisted={showPreviousVideoURL}
/>
<InputLabel
    label="Notes"
    fillWidth
    value={node.notes || ""}
    onChangeValue={async (value) => {
        const updatedNode = deepCloneJSON(node);
        updatedNode.notes = value;
        await VideoNode.set(node.id, updatedNode);
    }}
/>
```

## DiskCollection

If you read from a collection, mutate, and want to write back, shallow-copy so the collection notices the change:

```ts
let x = collection.get("x");
x.y = Math.random();
collection.set("x", { ...x });
```

Non-async getters go in render functions; async getters go in event handlers. `.set` works in both.

```ts
get(key: string): T | undefined;
async getPromise(key: string): Promise<T | undefined>;
set(key: string, value: T): void;
remove(key: string): void;
getKeys(): string[];
getKeysPromise(): Promise<string[]>;
getEntries(): [string, T][];
getValues(): T[];
async getValuesPromise(): Promise<T[]>;
getInfo(key: string);
async reset();
```

## API calls

In an event callback (which must be async):

```ts
APIController(getExtNodeId()).getModels.promise()
```

In a render function:

```ts
APIController(getExtNodeId()).getModels()
```
