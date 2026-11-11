/**
 * `@hearth/sdk/web`: what a mini-app's widget and page are built from.
 *
 * Today this is Hearth's UI kit: small, generic, themeable components that
 * the shell itself is built from too. They use only the design tokens (the
 * Tailwind class names the shell's styles define), so those names are part of
 * the SDK's version. The hooks (`appHooks`) join this entry point with the
 * step that draws widgets in the shell.
 *
 * Anything exported here is a promise to mini-apps in other repositories:
 * changing a component's props, or removing one, raises the SDK's version.
 */
export { Button, IconButton, buttonClass, type ButtonProps, type ButtonSize, type ButtonVariant, type IconButtonProps } from "./button";
export { Checkbox, type CheckboxProps } from "./checkbox";
export { Chip, chipClass, type ChipProps } from "./chip";
export { Dialog, DialogBody, type DialogProps } from "./dialog";
export { EmptyState, type EmptyStateProps } from "./empty-state";
export { Icon, type IconProps } from "./icon";
export { Field, Input, type FieldProps } from "./input";
export { Row, Rows } from "./rows";
export { Segmented, type SegmentedOption, type SegmentedProps } from "./segmented";
export { Switch, type SwitchProps } from "./switch";
export { Tag } from "./tag";
