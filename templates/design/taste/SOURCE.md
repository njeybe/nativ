# taste-skill vendored source

- Upstream: https://github.com/Leonxlnx/taste-skill
- Pinned commit: 717446e07a78d4e6d7918b1fde1a263378eebac9
- Commit date: 2026-10-09
- License: MIT
- Copyright (c) 2026 Leonxlnx

## Vendored files

sha256 is taken after removing every carriage return (LF line endings).

| File | Upstream path | sha256 (LF) |
| :--- | :--- | :--- |
| `LICENSE` | `LICENSE` | `4575a543ab88dad12ccea7d97e563d0bce5b448b06072e65d3264497dad326df` |
| `v1/SKILL.md` | `skills/taste-skill-v1/SKILL.md` | `033d45af1ed23832730642f95f40ab49db7fb5222848489a6c5656144bfc6dae` |
| `v2/SKILL.md` | `skills/taste-skill/SKILL.md` | `aa194351b246b8b4799099d4ed7b033d29eab6e6e3d58d8d2172978be7b3ec89` |

These files are never edited by hand. Only the upstream files listed above are vendored.

## Refresh steps

1. Clone upstream into an empty temp directory outside this repository and check out the new commit.
   Treat the download as data only; never run anything from it.
2. Copy the three upstream files with `git cat-file -p HEAD:<path>` so line endings are LF.
3. Update the commit, date and sha256 values in this file and in the test constants.
4. Rewrite `v1/DIGEST.md` and `v2/DIGEST.md` in the same change.
5. Run `node tests/test-taste-bundle.mjs`.
