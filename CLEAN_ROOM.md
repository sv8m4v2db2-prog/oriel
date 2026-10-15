# Clean-room procedure

*[Version française](CLEAN_ROOM.fr.md)*

Oriel is an **independent implementation** of the *ideas and principles* behind block-based
note-taking and workspace tools. No code, graphic asset, interface text or trademark of any
third-party product has been copied.

## Separation of roles

1. **Analysis**
   - The behaviour of an existing product was observed and studied, as a licensed user and
     through its publicly served web client without an account, solely to understand how it
     works: data model, synchronisation principles, user-visible behaviour.
   - This is what French law allows (article L122-6-1 III of the Code de la propriété
     intellectuelle, implementing article 5(3) of Directive 2009/24/EC): observing, studying or
     testing a program to determine the ideas and principles underlying it.
   - The analysis notes are kept outside this repository.
2. **Barrier**
   - The analysis was turned into natural-language documents: a functional specification
     ([`docs/SPEC.md`](docs/SPEC.md)), an original architecture
     ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), the `shared/` contract) and lists of missing
     features described as behaviours.
   - These documents contain no code, internal identifier or interface text of the studied
     product. They describe Oriel's own technical choices (fractional indexing, Yjs/BlockNote,
     WebSocket invalidations, SQLite…).
3. **Implementation** (`server/`, `web/`, `desktop/`, `mcp/`, `deploy/`)
   - Written by separate contributors who received only these documents and public product
     documentation.
   - They were explicitly forbidden to consult the studied product's code, its web client, its
     local cache or the analysis notes.
   - Third-party libraries are used only under free licences (see `package.json` and
     [`docs/NOTICE-DATA.md`](docs/NOTICE-DATA.md)).

## What is not reused

- Name, logo, icons, illustrations, interface texts, exact palette, templates.
- Code, file structures, internal identifiers, exact network protocol: Oriel uses its own REST and
  WebSocket contract (see `shared/src/api.ts` and `shared/src/events.ts`).

Import features read the export formats (Markdown, CSV, HTML, ZIP) of other tools, for
interoperability only.

> This document describes a process; it is not legal advice.
