/// <reference types="vite/client" />

/*
 * animal-island-ui publishes its stylesheet as `animal-island-ui/style`, a
 * subpath that maps to a plain CSS file. Its `exports` map carries no types for
 * that subpath, so the module shape is declared here instead of relying on the
 * generic `*.css` wildcard, which only matches specifiers ending in `.css`.
 */
declare module 'animal-island-ui/style'
