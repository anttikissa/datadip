# New project

An agent follows these steps to start a project from the boilerplate.

1. Copy the repository without its history, rename `app-boilerplate`
   everywhere, run `git init` and create the GitHub repository.
2. Replace the first paragraph of AGENTS.md with what the app is.
3. Ask the user about language and region defaults (DECISIONS.md,
   Clients).
4. Replace the placeholder icon (STYLE.md, App icon). Make the PNGs
   from the two SVGs with ImageMagick:

   ```sh
   cd public
   for v in '' -dev; do for s in 32 180 192 512 1024; do
     convert -background none -density 300 icon$v.svg -resize ${s}x$s icon$v-$s.png
   done; done
   ```
