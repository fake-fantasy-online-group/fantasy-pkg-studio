# Fantasy PKG Studio extension

This VS Code-compatible extension mounts each selected `.pkg` archive as a read-only workspace folder in the native Explorer. Package files open in native editor tabs with image, audio, text, or hex previews from the current studio core. Export, replacement, GSA PNG conversion, and repacking are available from the Explorer context menus.

Before packaging or launching the extension, run `npm run package:runtime` here. It copies the current `src/pkg.cjs` and `src/preview.cjs` into the extension runtime with `pngjs`; those generated copies should not be edited. Each mounted package has its own worker and replacement staging, and the source archive is never writable through the virtual filesystem.
