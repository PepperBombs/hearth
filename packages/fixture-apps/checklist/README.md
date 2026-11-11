# Checklist

A sample mini-app that belongs to the framework: a list of things to do,
ticked off as you go. The framework's tests run against it, and the scaffold
command will copy it as the start of a new app.

| File | Holds |
|---|---|
| `manifest.ts` | Name, icon, card size, two settings (`sections` for the space, `hideDone` for each person) and the interface strings, each in English and Chinese. |
| `server.ts` | One collection, `items` (`name`, `section`, `done`), and four routes: `list`, `add`, `tick` and `clearTicked`. |
| `widget.tsx` | The body of the dashboard card: the first six items still to do, each with a box to tick it off, and how many are left. |
| `page.tsx` | The app's own page: every item, grouped by the space's sections, a form to add one and a button to clear the ticked ones. Someone with view access gets the list and nothing to press. |
| `checklist.test.ts` | Its tests, written with `testApp` from `@hearth/sdk/testing` and run with `hearth-apps test`: what one person adds the others see, someone with view access changes nothing, ticking and clearing, names that are turned down, and the space's sections against each person's own switch. |
| `package.json` | The app's name. A mini-app declares no dependencies. |

Everything in it is sample data.
