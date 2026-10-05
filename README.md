# dsh-session-list-cache

A small [DeepSeek Harness (dsh)](https://www.npmjs.com/package/@deepseek-ai/dsh) web plugin
that stops an open dsh web page from costing a steady slice of a CPU core.

> A community plugin from SolidiFact. Not an official DeepSeek product.

## The problem

While a dsh web page is open, it refreshes the session list every 5 seconds. Each refresh
rebuilds the list row of every session you have ever kept, from its stored record, and
re-validates every stored value. Nothing about those sessions has changed, but the work is
done again anyway, and it grows with every session you keep.

Measured on one install with 763 stored sessions (dsh 0.1.7-rc.2, Apple M4):

| | Processor use with one dsh page open and nothing running |
|---|---|
| Without this plugin | 15.2% of one core |
| With this plugin | 8.1% of one core |

Each figure is the dsh web process's CPU time over two minutes, taken the same way both
times, with the same pages connected. The rest of the remaining cost is dsh reading the
session headers from disk, which this plugin does not change.

## What it does

A stored ("cold") session's row is built from two things: its header and its record in
dsh's projection cache. dsh never edits a stored record in place; every write stores new
objects. So when the header is unchanged and the record's contents are the very same stored
objects as last time, the row cannot have changed, and the row built last time is served
again.

Three safeguards:

- **No row is kept longer than a minute.** Part of a row is computed from the running dsh,
  not the stored record (image limits, and which plugin provides each tool). Right after
  dsh starts, plugins are still settling, and rows built then can differ from later ones.
  Rebuilding each row at least once a minute bounds that, and still skips 11 of every 12
  rebuilds.
- **It checks itself.** One reused row in every 100 is rebuilt anyway and compared. A
  difference is counted, the fresh row is served, and the first three are logged. Every 100
  list requests it logs one summary line. The first one on the test install:
  `[session-list-cache] 100 list requests, 76500 rows: 92% reused, 6108 built; 9034 spot-checked, 84 differed; 765 rows kept`
  (more spot-checks than usual, because every row was checked for a minute while testing;
  all 84 differences came from the first minute after startup, while plugins were loading,
  and none from the minute-long check of every row afterwards).
- **It fails safe.** It hooks an internal dsh class. If a dsh upgrade moves what it needs,
  it logs one warning and leaves dsh untouched. A record it cannot read is never cached.
  Sessions that are attached (open and live) are never cached.

It works with or without [`@michengai/dsh-archive-manager`](https://github.com/MichengAI/dsh-archive-manager),
which wraps the same projection cache.

## Install

Tested with dsh 0.1.7-rc.2.

1. Copy `index.mjs` into your dsh web profile folder as `session-list-cache.mjs`
   (for example `~/.dsh/profiles/web/session-list-cache.mjs`).
2. Add it to that profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: session-list-cache
         name: './session-list-cache.mjs'
   ```

3. Restart dsh web. Its log should show
   `[session-list-cache] unchanged cold sessions reuse their session-list row`.

To remove it, delete the insert and restart.

## Tuning

`createCache()` takes `checkEvery` (default 100), `reportEvery` (100 list requests) and
`maxAgeMs` (60000). The defaults are what the numbers above were measured with.

## Tests

```bash
node --test
```

The tests include the cases that broke earlier versions during development: a table that
returns a fresh wrapper object on every read, and a row whose live parts change while its
stored record does not.

## License

Copyright 2026 SolidiFact. Licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE).
