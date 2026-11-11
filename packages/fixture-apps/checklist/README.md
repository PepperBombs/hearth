# Checklist

A sample mini-app that belongs to the framework: a list of things to do,
ticked off as you go. The framework's tests run against it, and the scaffold
command will copy it as the start of a new app.

| File | Holds |
|---|---|
| `manifest.ts` | Name, icon, card size, two settings (`sections` for the space, `hideDone` for each person) and the interface strings, each in English and Chinese. |
| `server.ts` | One collection, `items` (`name`, `section`, `done`), and four routes: `list`, `add`, `tick` and `clearTicked`. |
| `widget.tsx` | The body of the dashboard card. A placeholder until widgets get their hooks. |
| `package.json` | The app's name. A mini-app declares no dependencies. |

Everything in it is sample data.
