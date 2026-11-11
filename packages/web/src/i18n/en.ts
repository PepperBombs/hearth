/**
 * English interface strings. This file defines the set of keys: zh.ts must
 * provide exactly the same ones, or the project does not compile.
 * Placeholders are written {like_this} and are checked by the `t` helper's types.
 */
export const en = {
  "app.loading": "Loading Hearth…",

  "nav.main": "Main",
  "nav.tabs": "Tabs",
  "nav.skip": "Skip to content",
  "nav.search": "Search or jump to…",
  "nav.dashboard": "Dashboard",
  "nav.apps": "Apps",
  "nav.settings": "Settings",
  "nav.personal": "Personal",
  "nav.noApps": "No apps yet",
  "nav.darkMode": "Dark mode",
  "nav.lightMode": "Light mode",
  "nav.switchLanguage": "Switch language",

  "tab.home": "Home",
  "tab.apps": "Apps",
  "tab.search": "Search",
  "tab.me": "Me",

  "topbar.search": "Search",

  "dashboard.title": "Dashboard",
  "dashboard.emptyTitle": "No widgets yet",
  "dashboard.emptyBody":
    "Widgets appear here when apps are added. Each app can show a small summary on this page, such as a list or today's numbers.",
  "dashboard.open": "Open",

  "apps.title": "Apps",
  "apps.pinned": "Pinned",
  "apps.pinnedNote": "Kept at the top",
  "apps.pinnedEmpty": "Nothing pinned yet.",
  "apps.onlyYou": "Only you",
  "apps.shared": "Shared space",
  "apps.personalEmpty": "No personal apps yet.",
  "apps.groupEmpty": "No apps in this space yet.",
  "apps.widgetOnly": "Widget only",
  "apps.emptyTitle": "No apps yet",
  "apps.emptyBody":
    "Apps are small tools that live in Hearth, such as a grocery list. When one is added to your personal space or to a shared space, it is listed here.",

  "appView.loading": "Loading…",
  "appView.failed": "This app could not be loaded.",
  "appView.retry": "Try again",
  "appView.outdated": "Hearth has been updated since you opened this page.",
  "appView.reload": "Reload to update",
  "appView.changeFailed": "That change could not be saved. Try again.",
  "appView.viewOnly": "You can look at this app, but not change anything in it.",

  "settings.title": "Settings",
  "settings.autosave": "Changes save automatically",
  "settings.appearance": "Appearance",
  "settings.theme": "Theme",
  "settings.themeLight": "Light",
  "settings.themeDark": "Dark",
  "settings.themeSystem": "System",
  "settings.themeHint": "System follows your device setting.",
  "settings.language": "Language",
  "settings.languageHint": "Each person chooses their own language.",
  "settings.account": "Account",
  "settings.name": "Name",
  "settings.nameHint": "Shown to people you share a space with.",
  "settings.nameSaved": "Saved",
  "settings.nameError": "The name could not be saved. Try again.",
  "settings.nameInvalid": "Enter a name of 1 to 80 characters.",
  "settings.email": "Email",
  "settings.emailHint": "Comes from your sign-in and cannot be changed here.",
  "settings.version": "Version",
  "settings.versionHint": "The build of Hearth this server is running.",
  "settings.signOutTitle": "Signing out",
  "settings.signOutBody":
    "Hearth has no sign-in page of its own. Cloudflare Access, which sits in front of this server, signs you in and out. Signing out ends your session on this device, and you sign in again the next time you open Hearth.",
  "settings.signOut": "Sign out",

  "save.failed": "Your choice could not be saved to the server. It is still applied on this device.",
  "save.retry": "Try again",
  "save.dismiss": "Dismiss",

  "switcher.label": "Quick switcher",
  "switcher.placeholder": "Search apps, pages and actions",
  "switcher.close": "Close search",
  "switcher.empty": "Nothing matches. Try another word.",
  "switcher.hintMove": "↑↓ move",
  "switcher.hintOpen": "↵ open",
  "switcher.hintClose": "esc close",
  "switcher.groupPages": "Pages",
  "switcher.groupApps": "Apps",
  "switcher.groupActions": "Actions",
  "switcher.openPage": "Open page",
  "switcher.openApp": "Open app",
  "switcher.action": "Action",
  "switcher.themeDark": "Switch to dark mode",
  "switcher.themeLight": "Switch to light mode",
  "switcher.themeSystem": "Use the device theme",

  "notMember.title": "You are not a member yet",
  "notMember.body":
    "You are signed in, but this Hearth has not been shared with you. Ask its owner to invite the email address you signed in with, then try again.",
  "notMember.retry": "Try again",
  "notMember.signOut": "Sign in with another account",

  "error.title": "Hearth could not load",
  "error.network":
    "The server could not be reached. Check your connection. If you were signed out, reloading the page takes you to sign in again.",
  "error.unauthenticated": "The server does not know who you are. Reload the page to sign in again.",
  "error.server": "The server ran into a problem. Wait a moment, then try again.",
  "error.invalid": "The server sent something this version of Hearth does not understand. Reloading usually fixes it.",
  "error.retry": "Try again",
  "error.reload": "Reload the page",
  "error.details": "Details: {code}",

  "notFound.title": "Page not found",
  "notFound.heading": "Nothing at this address",
  "notFound.body": "The page may have moved, or the link may be wrong.",
  "notFound.back": "Go to the dashboard",
} as const;
