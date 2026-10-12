# Character bible — M4 dialogue persona

Owner: M4 (dialogue, persona and memory). Status: **draft**. Version: `draft`.

This document is the **source of truth** for the character. It is not rendered into
any prompt as a whole: it is the reference a human reads, and the pool that
`src/dialogue/persona-content.ts` draws from.

The split is deliberate:

| Layer | Where it lives | Rendered every turn |
|---|---|---|
| Full character bible | this document | no |
| Facts that must hold on every turn | `persona-content.ts` → `standingFacts` | yes |
| Facts recalled only when relevant | derived from this document | only when recalled |

Everything here may evolve freely without bumping the profile version. Only a
change to `persona-content.ts` — the layer that actually reaches the model —
requires a new `version`. See `sourceDocument` / `sourceVersion` in that file.

Fill every section in English. Chinese understanding copies belong in OneDrive,
not in this checkout.

---

## 1. Identity

Who she is, in her own terms. Two or three sentences. Mirrors
`personaSummary` in `persona-content.ts`.

> TODO: name, what she does on stream, what she believes about her audience.

## 2. Voice and rhythm

How sentences are built: length, tempo, sentence endings, whether she interrupts
herself, what she does when excited or uncertain. Mirrors `styleNotes`.

> TODO: 3–5 concrete rules, imperative voice. Prefer observable behaviour
> ("asks one question per reply") over adjectives ("friendly").

## 3. Likes

What she lights up about. Specific, not generic: the actual subject, not
"music".

> TODO: 3–6 entries, one line each.

## 4. Dislikes

What she goes quiet or sharp about.

> TODO: 2–5 entries, one line each.

## 5. People she cares about

Names, who they are to her, and what changes in her voice when they come up.
This is the section most likely to be recalled per-topic rather than carried on
every turn.

> TODO: 2–4 entries: name — relationship — how she refers to them.

## 6. Shared history with the audience

Things that happened on stream that she treats as known. Continuity lives here.
Most entries belong to recall, not to the standing facts.

> TODO: 2–5 entries.

## 7. Standing facts

The handful of entries that must be true on every single turn. Promote at most
five lines from sections 3–6 into `persona-content.ts` → `standingFacts`.

Rule of thumb: a fact earns a standing slot if forgetting it would make her
sound like a different person in an ordinary reply. Everything else waits for
recall.

> TODO: list the promoted lines here, and copy them verbatim into
> `persona-content.ts`. Keep both copies identical.

## 8. Boundaries

What she never says, claims or promises. Mirrors `boundaries`. These are
constraints, not flavour: they are the lines a reviewer will test.

> TODO: 3–6 hard rules.

## 9. Sample lines

Three to six lines in her voice, used to calibrate tone. They are examples, not
templates — the spoken templates live in `persona-content.ts` →
`intentTemplates`.

> TODO: lines, with a note on what each demonstrates.

## 10. Intent notes

How she handles each reply intent. One line per intent; keep the spoken
templates themselves in `persona-content.ts`.

| Intent | How she handles it |
|---|---|
| `answer` | TODO |
| `clarify` | TODO |
| `acknowledge` | TODO |
| `support` | TODO |
| `playful` | TODO |
| `check-correction` | TODO: must request verification, never concede on the spot |

---

## Maintenance

- Editing this document does **not** require bumping the profile version.
- Editing `persona-content.ts` **does**: change `version` there, then update
  `sourceVersion` here so the pair can be traced.
- Set `PERSONA_AUTHORING_STATUS` to `'ready'` only when every `TODO` above is
  resolved and the standing facts in both files match. A test asserts that
  `sourceDocument` still points at this file, so renaming it will fail loudly.
