# Vault seed

Content copied into AKIRA's vault (`data/akira-memory`) by `pnpm vault:migrate`.

The vault is a separate git repository and is not part of this repo, so
anything that ships with the product lives here first.

**Copies happen only when the destination does not exist.** An operator edit in
the vault always wins. To push an updated version of a shipped skill, delete the
vault's copy and re-run the migration.

`skills/obsidian-markdown/` is vendored from
[kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) (MIT). Its
`LICENSE` travels with it. It does not track upstream.
