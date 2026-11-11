# Feed

A sample mini-app that belongs to the framework: a card that each person
filters for themselves. It has a widget and no server file, so it keeps no
rows, and both of its settings belong to the person, not to the space. The
framework's tests use it for everything an app without data must still do.

| File | Holds |
|---|---|
| `manifest.ts` | Name, icon, card size, two settings for each person (`topics`, `period`) and the interface strings, each in English and Chinese. |
| `widget.tsx` | The body of the dashboard card. A placeholder until widgets get their hooks. |
| `package.json` | The app's name. A mini-app declares no dependencies. |

Everything in it is sample data.
