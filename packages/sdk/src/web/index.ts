/**
 * `@hearth/sdk/web`: what a mini-app's widget and page are built from.
 *
 * Two things: the hooks (`appHooks`), which give a widget its data, its
 * strings and its settings, and Hearth's UI kit: small, generic, themeable
 * components that the shell itself is built from too. The components use
 * only the design tokens (the Tailwind class names the shell's styles
 * define), so those names are part of the SDK's version.
 *
 * Anything exported here is a promise to mini-apps in other repositories:
 * changing a component's props, or removing one, raises the SDK's version.
 */
export { Button, IconButton, buttonClass, type ButtonProps, type ButtonSize, type ButtonVariant, type IconButtonProps } from "./button";
export { Checkbox, type CheckboxProps } from "./checkbox";
export { Chip, chipClass, type ChipProps } from "./chip";
export { Dialog, DialogBody, type DialogProps } from "./dialog";
export { EmptyState, type EmptyStateProps } from "./empty-state";
export {
  appHooks,
  type AppContext,
  type AppHooks,
  type AppLike,
  type InputArgs,
  type MutationName,
  type MutationResult,
  type Output,
  type QueryName,
} from "./hooks";
export { Icon, type IconProps } from "./icon";
export { Field, Input, type FieldProps } from "./input";
export { Row, Rows } from "./rows";
export { Segmented, type SegmentedOption, type SegmentedProps } from "./segmented";
export { Switch, type SwitchProps } from "./switch";
export { Tag } from "./tag";
