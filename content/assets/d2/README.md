# Diagram icons

Vendored from [D2 Icons](https://icons.d2lang.com/) so rendering and reading the site do not require third-party image requests:

| File | Download source | Upstream collection |
| --- | --- | --- |
| `postgresql.svg` | <https://icons.d2lang.com/dev/postgresql.svg> | Devicon |
| `java.svg` | <https://icons.d2lang.com/dev/java.svg> | Devicon |

Devicon's MIT license is included in `LICENSE.devicon`. Product names and logos remain the trademarks of their respective owners; usage does not imply endorsement. See also <https://github.com/devicons/devicon>.

`source.config.ts` allowlists only this directory using `assetsRoot`. In a page under `content/docs/<section>/`, use `icon: ../../assets/d2/postgresql.svg`. The docs-kit build embeds the SVG as a data URL and includes its contents in the D2 cache key. Keep this directory small; do not put untrusted SVG or symlinks here.
