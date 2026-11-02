# AVeRA Class Portal — Design Notes

## Design direction

The interface should feel calm, trustworthy, and practical for a teacher working with classroom records. Prioritize readable information, clear actions, and privacy cues over decorative density.

## Visual system in the current app

The current UI uses a light paper background, white panels, deep teal/navy navigation, green primary actions, and restrained amber accents. These values are currently defined in `app/globals.css`:

| Role | Current value |
|---|---|
| Page background | `#f5f7f4` |
| Primary text | `#1d2c2a` |
| Muted text | `#71807a` |
| Borders | `#dfe7e1` |
| Primary green | `#176b58` |
| Deep navy | `#183c48` |
| Amber accent | `#d68a36` |

Use the existing design tokens and components before adding new colors or one-off styling. Keep contrast readable and ensure status is not communicated by color alone.

## Layout and behavior

- Authentication pages use a two-column story/form layout on wide screens and a stacked layout on narrow screens.
- The dashboard uses a persistent desktop sidebar, a simple top bar, four summary cards, and two overview panels.
- At tablet widths, summary cards reduce to two columns and panels stack. At phone widths, navigation and content collapse to a single column.
- Use clear page titles, short supporting text, labeled form controls, visible validation/error messages, and empty states that explain the next action.
- Reports should be legible when exported to A4 PDF, including when content spans multiple pages.

## Current boundaries

Dashboard navigation items for learners, attendance, grades, and reports are not all implemented as routes yet. Do not style them as available workflows until those pages exist. Design additions must account for the difference between seeded/demo values and real Supabase records.
