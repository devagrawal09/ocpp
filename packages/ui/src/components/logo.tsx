import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 138 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        <path d="M24 36H6V12H24V36Z" fill="var(--icon-weak-base)" />
        <path d="M24 6H6V36H24V6ZM30 42H0V0H30V42Z" fill="var(--icon-base)" />
        <path d="M66 36H42V12H66V36Z" fill="var(--icon-weak-base)" />
        <path d="M66 6H42V36H66V42H36V0H66V6Z" fill="var(--icon-base)" />
        <path d="M90 6V18H102V24H90V36H84V24H72V18H84V6H90Z" fill="var(--icon-strong-base)" />
        <path d="M126 6V18H138V24H126V36H120V24H108V18H120V6H126Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
