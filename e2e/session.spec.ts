import { expect, test } from "./fixtures.ts";

test("someone who is signed in but not invited sees the not-a-member screen", async ({ page, api }) => {
  api.failSession(403, "not_a_member", "sam@example.com is not a member of this Hearth.");
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "You are not a member yet" })).toBeVisible();
  await expect(page.getByText(/Ask its owner to invite the email address you signed in with/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with another account" })).toHaveAttribute(
    "href",
    "/cdn-cgi/access/logout",
  );
  await expect(page.getByRole("navigation")).toHaveCount(0);
  // "You may not" is an answer, not a glitch: it is not asked again behind the person's back.
  expect(api.sessionRequests).toBe(1);

  // The screen can be read in Chinese too, without a session to save the choice to.
  await page.getByRole("button", { name: /中文/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "你还不是成员" })).toBeVisible();
  expect(api.saved).toEqual([]);
  await page.getByRole("button", { name: /English/ }).click();

  // Once the owner has sent the invitation, trying again lets them in.
  api.setSession(api.session);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("a server failure shows an error screen with a way to try again", async ({ page, api }) => {
  api.failSession(500, "internal");
  await page.goto("/settings");

  await expect(page.getByRole("heading", { level: 1, name: "Hearth could not load" })).toBeVisible();
  await expect(page.getByText("The server ran into a problem.")).toBeVisible();
  await expect(page.getByText("Details: internal")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload the page" })).toBeVisible();

  api.setSession(api.session);
  await page.getByRole("button", { name: "Try again" }).click();
  // The address asked for is kept.
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
});

test("an unreachable server is explained as a connection problem", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Hearth could not load" })).toBeVisible();
  await expect(page.getByText("The server could not be reached.")).toBeVisible();
});

test("a reply that does not match the contract is refused rather than half-shown", async ({ page }) => {
  await page.route("**/api/session", (route) => route.fulfill({ json: { user: { id: "user-1" }, apps: "none" } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Hearth could not load" })).toBeVisible();
  await expect(page.getByText("Details: invalid_response")).toBeVisible();
});

test("a missing identity asks the person to reload and sign in", async ({ page, api }) => {
  api.failSession(401, "unauthenticated");
  await page.goto("/");
  await expect(page.getByText("The server does not know who you are.")).toBeVisible();
});
